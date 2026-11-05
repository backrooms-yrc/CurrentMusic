import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import sys
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cm_ncm
import cm_search_catalog as catalog
import test_password_reset as harness


class SearchRealIpTests(unittest.TestCase):
    setUp = harness.TestPasswordReset.setUp
    _cleanup = harness.TestPasswordReset._cleanup
    call = harness.TestPasswordReset.call

    def test_custom_search_uses_client_ip_and_isolates_cached_pages(self):
        data = {'songs': [], 'totals': {'song': 0}, 'hasMore': {'song': False}}
        with mock.patch.object(cm_ncm, 'search_types', return_value=data) as search:
            url = '/ncm/search?keywords=fixture&type=song&realIP=203.0.113.99'
            self.assertEqual(self.call('GET', url, ip='198.51.100.21')[0], 200)
            self.assertEqual(search.call_args.kwargs['real_ip'], '198.51.100.21')
            self.call('GET', url, ip='198.51.100.21')
            self.assertEqual(search.call_count, 1)
            self.call('GET', url, ip='198.51.100.22')
            self.assertEqual(search.call_count, 2)
            self.assertEqual(search.call_args.kwargs['real_ip'], '198.51.100.22')

    def test_generic_search_strips_spoofed_realip_before_trusted_injection(self):
        with mock.patch.object(cm_ncm, 'call', return_value={'code': 200, 'result': {}}) as upstream:
            url = '/ncm/cloudsearch?keywords=fixture&realIP=203.0.113.99'
            for ip in ('198.51.100.21', '198.51.100.21', '198.51.100.22'):
                self.assertEqual(self.call('GET', url, ip=ip)[0], 200)
            self.assertEqual(upstream.call_count, 2)
            self.assertEqual([c.args[1]['realIP'] for c in upstream.call_args_list], ['198.51.100.21', '198.51.100.22'])

    def test_all_search_helpers_forward_the_same_client_ip(self):
        with mock.patch.object(cm_ncm, 'call', return_value={'result': {}}) as upstream:
            cm_ncm.search('fixture', real_ip='198.51.100.21')
            cm_ncm.search_types('fixture', real_ip='198.51.100.21')
            cm_ncm.search_multi('fixture', real_ip='198.51.100.21')
            self.assertEqual(upstream.call_count, 9)
            self.assertTrue(all(c.kwargs['real_ip'] == '198.51.100.21' for c in upstream.call_args_list))

    def test_catalog_results_do_not_modify_upstream_pagination(self):
        raw = {'songs': [{'ncm_id': 2}], 'totals': {'song': 11}, 'hasMore': {'song': True}}
        exact = [{'ncm_id': 1, 'name': 'fixture', 'artists': 'artist'}]
        with mock.patch.object(cm_ncm, 'search_types', return_value=raw), mock.patch.object(catalog, 'find', return_value=exact):
            _, data = self.call('GET', '/ncm/search?keywords=fixture&type=song&limit=10')
            self.assertEqual(data['catalogSongs'], exact)
            self.assertEqual(data['songs'], [{'ncm_id': 2}])
            self.assertEqual(data['totals']['song'], 11)
            _, second = self.call('GET', '/ncm/search?keywords=fixture&type=song&limit=10&offset=10')
            self.assertNotIn('catalogSongs', second)


class PublicCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'catalog.json'
        self.patch = mock.patch.object(catalog, 'PATH', self.path)
        self.patch.start()
        catalog._stamp = None
        self.addCleanup(self.patch.stop)
        self.addCleanup(self.temp.cleanup)

    def test_exact_title_artist_and_deduplication(self):
        song = {'ncm_id': 1, 'name': '七里香', 'artists': '周杰伦', 'album': '七里香'}
        self.path.write_text(json.dumps({'version': 1, 'songs': [song]}))
        self.assertEqual(catalog.find('周杰伦 七里香')[0]['ncm_id'], 1)
        self.assertEqual(catalog.find('七里香')[0]['catalogSource'], 'netease-album')
        self.assertEqual(catalog.find('七里香', exclude=['1']), [])
        self.assertEqual(catalog.find('七里'), [])
        self.assertEqual(catalog.find('another song'), [])

    def test_missing_or_corrupt_catalog_never_breaks_search(self):
        self.assertEqual(catalog.find('fixture'), [])
        self.path.write_text('invalid JSON')
        self.assertEqual(catalog.find('fixture'), [])
        self.path.write_text(json.dumps({'version': 1, 'songs': [{'ncm_id': 'invalid', 'name': 'fixture'}]}))
        self.assertEqual(catalog.find('fixture'), [])

    def test_public_update_is_atomic_and_never_reads_user_cookie(self):
        spec = importlib.util.spec_from_file_location('catalog_updater', Path(__file__).resolve().parents[2] / 'tools/update-search-catalog.py')
        updater = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(updater)
        def response(path, params, **kwargs):
            self.assertFalse(kwargs['with_cookie'])
            if path == '/artist/album':
                return {'hotAlbums': [{'id': 5}], 'more': False}
            return {'songs': [{'id': 1, 'name': 'fixture', 'ar': [{'id': 2, 'name': 'artist'}], 'al': {'name': 'album'}}]}
        with mock.patch.object(cm_ncm, 'call', side_effect=response):
            self.assertEqual(updater.update([2], self.path), (1, 1))
        previous = self.path.read_bytes()
        with mock.patch.object(cm_ncm, 'call', side_effect=cm_ncm.NcmError('temporary')):
            with self.assertRaises(cm_ncm.NcmError): updater.update([2], self.path)
        self.assertEqual(previous, self.path.read_bytes())
