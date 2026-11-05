import json
import time
import unittest
import sys
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
