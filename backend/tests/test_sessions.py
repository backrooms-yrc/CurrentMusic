"""Unlimited device sessions and explicit device management, using a temporary DB."""
import hashlib
import time
import unittest
from unittest import mock

import test_password_reset as harness
import cm_db
import cm_server


class TestSessions(unittest.TestCase):
    call = harness.TestPasswordReset.call
    make_user = harness.TestPasswordReset.make_user
    _cleanup = harness.TestPasswordReset._cleanup

    def setUp(self):
        harness.TestPasswordReset.setUp(self)
        patch = mock.patch.object(cm_server.cm_region, 'note')
        patch.start()
        self.addCleanup(patch.stop)
        self.uid = self.make_user()
        self.token = cm_db.issue_token(self.uid, 'Original device', 'web')
        self.sid = hashlib.sha256(self.token.encode()).hexdigest()
        self.grant_access = 'fixture-session-grant'
        cm_db.passport_grant_create('fixture-grant', 'fixture-app', self.uid, 'profile',
                                   self.grant_access, 'fixture-refresh', int(time.time()) + 3600,
                                   int(time.time()) + 7200, sid=self.sid)
        # Make the original device unambiguously oldest, as it used to be evicted.
        with cm_db.connect() as conn:
            conn.execute('UPDATE sessions SET last_seen=1 WHERE token_hash=?', (self.sid,))

    def login_devices(self, count=8):
        tokens = []
        for i in range(count):
            status, response = self.call('POST', '/auth/login', {
                'username': 'alice', 'password': 'oldpass',
                'device': f'Additional device {i}', 'platform': 'web',
            })
            self.assertEqual(status, 200)
            tokens.append(response['token'])
        return tokens

    def test_new_logins_keep_all_devices_and_existing_passport_grant(self):
        tokens = [self.token] + self.login_devices()
        for token in tokens:
            self.assertEqual(self.call('GET', '/auth/me', token=token)[0], 200)
        status, data = self.call('GET', '/auth/sessions', token=self.token)
        self.assertEqual(status, 200)
        self.assertIsNone(data['max'])
        self.assertEqual(len(data['sessions']), 9)
        self.assertEqual(sum(s['current'] for s in data['sessions']), 1)
        self.assertEqual(len({s['id'] for s in data['sessions']}), 9)
        self.assertIsNotNone(cm_db.passport_grant_by_access(self.grant_access))

    def test_single_device_and_other_device_revocation_still_work(self):
        tokens = self.login_devices()
        other_uid = cm_db.create_user('bob', 'password', 'Bob')
        other_token = cm_db.issue_token(other_uid)
        own_session = cm_db.list_sessions(self.uid, tokens[-1])
        original = next(s for s in own_session if s['device'] == 'Original device')
        # Another account cannot revoke this session.
        self.assertEqual(self.call('DELETE', '/auth/sessions/' + original['id'], token=other_token)[0], 404)
        self.assertIsNotNone(cm_db.user_by_token(self.token))
        status, _ = self.call('DELETE', '/auth/sessions/' + original['id'], token=tokens[-1])
        self.assertEqual(status, 200)
        self.assertEqual(self.call('GET', '/auth/me', token=self.token)[0], 401)
        self.assertIsNone(cm_db.passport_grant_by_access(self.grant_access))
        self.assertEqual(len(cm_db.list_sessions(self.uid)), 8)
        status, data = self.call('DELETE', '/auth/sessions/others', token=tokens[-1])
        self.assertEqual(status, 200)
        self.assertEqual(data['removed'], 7)
        remaining = cm_db.list_sessions(self.uid, tokens[-1])
        self.assertEqual(len(remaining), 1)
        self.assertTrue(remaining[0]['current'])
        self.assertIsNotNone(cm_db.user_by_token(other_token))
        for token in tokens[:-1]:
            self.assertIsNone(cm_db.user_by_token(token))

    def test_logout_only_revokes_current_session(self):
        tokens = self.login_devices()
        self.assertEqual(self.call('GET', '/auth/sessions')[0], 401)
        self.assertEqual(self.call('POST', '/auth/logout', token=self.token)[0], 200)
        self.assertIsNone(cm_db.user_by_token(self.token))
        self.assertIsNone(cm_db.passport_grant_by_access(self.grant_access))
        self.assertEqual(len(cm_db.list_sessions(self.uid)), 8)
        for token in tokens:
            self.assertIsNotNone(cm_db.user_by_token(token))


if __name__ == '__main__':
    unittest.main()
