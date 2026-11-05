import io
import json
import time
import unittest
import sys
import urllib.error
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cm_db
import cm_ncm
import cm_server
import test_password_reset as harness


class NcmLikeStateTests(unittest.TestCase):
    setUp = harness.TestPasswordReset.setUp
    _cleanup = harness.TestPasswordReset._cleanup
    call = harness.TestPasswordReset.call

    def user(self):
        uid = cm_db.create_user('like-fixture', 'fixture-password', 'Fixture')
        cm_db.save_binding(uid, 'fixture-cookie', 42)
        return uid, cm_db.issue_token(uid)

    def test_successful_like_and_unlike_overlay_delayed_upstream(self):
        uid, token = self.user()
        with mock.patch.object(cm_ncm, 'like_song', return_value=True), \
             mock.patch.object(cm_ncm, 'likelist', return_value=[]) as listing, \
             mock.patch.object(cm_server, '_ncm_like_counts', return_value={1: 9}):
            self.assertEqual(self.call('GET', '/ncmbind/likelist', token=token)[1]['ids'], [])
            status, result = self.call('POST', '/ncmbind/like/1', {'name': 'Fixture', 'like': True}, token=token)
            self.assertEqual(status, 200)
            self.assertTrue(result['liked'])
            self.assertEqual(self.call('GET', '/ncmbind/likelist?refresh=1', token=token)[1]['ids'], [1])
            listing.return_value = [1]
            self.assertEqual(self.call('GET', '/ncmbind/likelist?refresh=1', token=token)[1]['ids'], [1])
            self.call('POST', '/ncmbind/like/1', {'name': 'Fixture', 'like': False}, token=token)
            self.assertEqual(self.call('GET', '/ncmbind/likelist?refresh=1', token=token)[1]['ids'], [])

    def test_radio_500_updates_only_the_verified_liked_playlist(self):
        uid, token = self.user()
        snapshot = cm_db.create_playlist(uid, '我喜欢', '', source='ncm', ncm_pl_id=200)
        unrelated = cm_db.create_playlist(uid, '普通歌单', '', source='ncm', ncm_pl_id=201)
        cm_db.set_binding_liked_pl(uid, 201)
        requests = []

        def upstream(request, timeout):
            path = request.full_url.removeprefix(cm_ncm.BASE)
            body = json.loads(request.data)
            self.assertEqual(request.get_method(), 'POST')
            self.assertEqual(request.get_header('X-apicache-bypass'), '1')
            self.assertEqual(body.pop('cookie'), 'fixture-cookie; os=pc')
            requests.append((path, body))
            if path == '/like':
                raise urllib.error.HTTPError(request.full_url, 500, 'Internal Server Error', {},
                                             io.BytesIO(b'{"songs":[],"playlistId":200,"code":500}'))
            if path == '/user/playlist':
                return io.BytesIO(b'{"code":200,"playlist":[{"id":200,"userId":42,"specialType":5}]}')
            self.assertEqual(path, '/playlist/tracks')
            return io.BytesIO(b'{"status":200,"body":{"code":200}}')

        with mock.patch.object(cm_ncm.urllib.request, 'urlopen', side_effect=upstream), \
             mock.patch.object(cm_server, '_ncm_like_counts', return_value={1: 9}):
            for like in (True, False):
                with self.subTest(like=like):
                    status, result = self.call('POST', '/ncmbind/like/1', {'name': 'Fixture', 'like': like}, token=token)
                    self.assertEqual((status, result), (200, {'liked': like, 'count': 9}))
                    self.assertEqual(cm_db.playlist_track_ids(snapshot), [1] if like else [])
                    self.assertEqual(cm_db.playlist_track_ids(unrelated), [])
                    self.assertEqual(requests[-3:], [
                        ('/like', {'id': 1, 'like': 'true' if like else 'false', 'realIP': '10.0.0.1'}),
                        ('/user/playlist', {'uid': 42, 'limit': 10}),
                        ('/playlist/tracks', {'pid': 200, 'tracks': '1', 'op': 'add' if like else 'del', 'realIP': '10.0.0.1'}),
                    ])

    def test_radio_500_cannot_update_a_regular_or_other_accounts_playlist(self):
        uid, token = self.user()
        for owner, special_type, subscribed in [(43, 5, False), (42, 0, False), (42, 5, True)]:
            with self.subTest(owner=owner, special_type=special_type, subscribed=subscribed):
                radio_error = cm_ncm.NcmError('radio failure', status_code=500, response={'code': 500, 'playlistId': 200})
                playlists = {'code': 200, 'playlist': [{'id': 200, 'userId': owner, 'specialType': special_type,
                                                       'subscribed': subscribed}]}
                with mock.patch.object(cm_ncm, 'post_json', side_effect=[radio_error, playlists]) as upstream:
                    status, result = self.call('POST', '/ncmbind/like/1', {'name': 'Fixture'}, token=token)
                self.assertEqual(status, 502)
                self.assertIn('未能确认', result['error'])
                self.assertEqual(upstream.call_count, 2)
                self.assertIsNone(cm_db.cache_get(cm_server._ncm_like_pending_key(uid, cm_db.get_binding(uid))))

    def test_failed_mutations_do_not_record_likes(self):
        uid, token = self.user()
        cases = [
            ([cm_ncm.NcmError('login required', status_code=301)], 401, '重新绑定'),
            ([cm_ncm.NcmError('rate limited', status_code=429)], 429, 'rate limited'),
            ([cm_ncm.NcmError('timed out')], 502, 'timed out'),
            ([cm_ncm.NcmError('radio failure', status_code=500, response={'code': 500, 'playlistId': 200}),
              {'code': 200, 'playlist': [{'id': 200, 'userId': 42, 'specialType': 5}]},
              {'status': 200, 'body': {'code': 403}}], 403, '未能更新'),
        ]
        for replies, expected, message in cases:
            with self.subTest(status=expected), mock.patch.object(cm_ncm, 'post_json', side_effect=replies) as upstream:
                status, result = self.call('POST', '/ncmbind/like/1', {'name': 'Fixture'}, token=token)
                self.assertEqual(status, expected)
                self.assertIn(message, result['error'])
                self.assertEqual(upstream.call_count, len(replies))
                self.assertIsNone(cm_db.cache_get(cm_server._ncm_like_pending_key(uid, cm_db.get_binding(uid))))

    def test_inflight_list_cannot_erase_new_write(self):
        uid, token = self.user()
        binding = cm_db.get_binding(uid)
        def delayed_list(*args):
            cm_server._remember_ncm_like(uid, binding, 1, True)
            return []
        with mock.patch.object(cm_ncm, 'likelist', side_effect=delayed_list):
            self.assertEqual(self.call('GET', '/ncmbind/likelist', token=token)[1]['ids'], [1])

    def test_intents_expire_and_are_scoped_to_bound_account(self):
        uid, token = self.user()
        binding = cm_db.get_binding(uid)
        key = cm_server._ncm_like_pending_key(uid, binding)
        cm_db.cache_set(key, json.dumps({'1': {'on': True, 'at': time.time() - 121}}), 120)
        with mock.patch.object(cm_ncm, 'likelist', return_value=[]):
            self.assertEqual(self.call('GET', '/ncmbind/likelist?refresh=1', token=token)[1]['ids'], [])
            cm_server._remember_ncm_like(uid, binding, 1, True)
            cm_db.cache_set(f'nlikes:{uid}:42', '[1]', 600)
            cm_db.save_binding(uid, 'other-fixture-cookie', 43)
            self.assertEqual(self.call('GET', '/ncmbind/likelist', token=token)[1]['ids'], [])
