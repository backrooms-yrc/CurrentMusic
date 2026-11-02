import http.client
from http.server import ThreadingHTTPServer
from pathlib import Path
import json
import sys
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cm_lines
from cm_server import Handler


class NetworkLinesTests(unittest.TestCase):
    def setUp(self):
        self.cache = patch.multiple(cm_lines, _cache=None, _expires=0)
        self.cache.start()
        self.addCleanup(self.cache.stop)

    def test_directory_does_not_probe(self):
        with patch.object(cm_lines, 'probe') as probe:
            result = cm_lines.snapshot(False)
        probe.assert_not_called()
        self.assertEqual(len(result['lines']), 4)
        self.assertEqual(len({x['id'] for x in result['lines']}), 4)
        self.assertIsNone(result['measuredAt'])

    def test_cached_results_are_copied_and_bounded(self):
        with patch.object(cm_lines, 'probe', return_value={'available':True, 'latencyMs':3, 'status':'ok', 'httpStatus':200}) as probe:
            result = cm_lines.snapshot()
            self.assertEqual(probe.call_count, 4)
            result['lines'].clear()
            again = cm_lines.snapshot()
            self.assertTrue(again['cached'])
            self.assertEqual(len(again['lines']), 4)
            self.assertEqual(probe.call_count, 4)

    def test_concurrent_request_does_not_wait_or_duplicate(self):
        with cm_lines._lock:
            with patch.object(cm_lines, 'probe') as probe:
                self.assertTrue(cm_lines.snapshot()['measuring'])
                probe.assert_not_called()

    def test_invalid_body_is_not_available(self):
        from io import BytesIO
        class Response(BytesIO):
            status = 200
        with patch('urllib.request.build_opener') as opener:
            opener.return_value.open.return_value = Response(b'{"ok":true,"service":"other"}')
            self.assertEqual(cm_lines.probe(cm_lines.catalog()[0]['probeUrl'])['status'], 'invalid_response')

    def test_http_routes_and_no_store(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            for path in ('/network/probe', '/network/lines?measure=0'):
                conn = http.client.HTTPConnection(*server.server_address, timeout=3)
                conn.request('GET', path)
                response = conn.getresponse()
                self.assertEqual(response.status, 200)
                data = response.read()
                if path != '/network/docs':
                    self.assertEqual(response.getheader('Cache-Control'), 'no-store')
                    self.assertEqual(response.getheader('Access-Control-Allow-Origin'), '*')
                    self.assertIsInstance(json.loads(data), dict)
                conn.close()
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=3)

    def test_legacy_documentation_redirects(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            for prefix in ('',):  # Nginx removes /cm before proxying to Handler.
                for old, section in (('passport', 'guide-passport-api'), ('network', 'guide-network-lines-api')):
                    for suffix in ('', '/'):
                        with self.subTest(prefix=prefix, old=old, suffix=suffix):
                            conn = http.client.HTTPConnection(*server.server_address, timeout=3)
                            conn.request('GET', f'{prefix}/{old}/docs{suffix}')
                            response = conn.getresponse()
                            self.assertEqual(response.status, 302)
                            self.assertEqual(response.getheader('Location'), f'/api-docs/reference/{section}/')
                            self.assertEqual(response.getheader('Cache-Control'), 'no-cache')
                            self.assertEqual(response.read(), b'')
                            conn.close()
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=3)
