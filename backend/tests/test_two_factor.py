"""Route-level MFA tests: temporary DB only, no mail/network calls."""
import base64
import concurrent.futures
import os
import sys
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import test_password_reset as harness
import cm_2fa
import cm_db
import cm_server


class TestTwoFactor(unittest.TestCase):
    call = harness.TestPasswordReset.call
    make_user = harness.TestPasswordReset.make_user
    _cleanup = harness.TestPasswordReset._cleanup
    # Reuse the isolated database and HTTP harness, without inheriting reset cases.
    def setUp(self):
        harness.TestPasswordReset.setUp(self)
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(cm_server.cm_region, 'note').start()
        self.uid = self.make_user()
        self.token = cm_db.issue_token(self.uid, 'current')
        self.other = cm_db.issue_token(self.uid, 'other')

    def request(self, action, body=None, token=None):
        return self.call('GET' if action == 'status' else 'POST', '/auth/2fa/' + action,
                         body, token=self.token if token is None else token)

    def setup_factor(self):
        status, data = self.request('setup', {'password': 'oldpass'})
        self.assertEqual(status, 200, data)
        self.secret = data['secret']
        self.assertIn('otpauth://totp/', data['uri'])
        self.step = int(time.time()) // 30
        status, data = self.request('enable', {'code': cm_2fa.totp(self.secret, self.step - 1)})
        self.assertEqual(status, 200, data)
        self.codes = data['recoveryCodes']
        return data

    def challenge(self):
        status, data = self.call('POST', '/auth/login', {'username': 'alice', 'password': 'oldpass'})
        self.assertEqual(status, 200, data)
        self.assertTrue(data['requires2FA'])
        self.assertNotIn('token', data)
        self.assertNotIn('user', data)
        self.assertIsNone(cm_db.user_by_token(data['challengeToken']))
        return data['challengeToken']

    def test_totp_standard_vectors(self):
        secret = base64.b32encode(b'12345678901234567890').decode()
        for timestamp, expected in [(59, '94287082'), (1111111109, '07081804'),
                                    (1234567890, '89005924'), (20000000000, '65353130')]:
            self.assertEqual(cm_2fa.totp(secret, timestamp // 30, 8), expected)

    def test_full_login_replay_and_disable(self):
        self.setup_factor()
        self.assertIsNone(cm_db.user_by_token(self.other))
        self.assertIsNotNone(cm_db.user_by_token(self.token))
        challenge = self.challenge()
        status, result = self.request('login', {'challengeToken': challenge, 'code': cm_2fa.totp(self.secret, self.step)}, token='')
        self.assertEqual(status, 200, result)
        self.assertIsNotNone(cm_db.user_by_token(result['token']))
        self.assertEqual(self.request('login', {'challengeToken': challenge, 'code': self.codes[0]}, token='')[0], 400)
        challenge = self.challenge()
        self.assertEqual(self.request('login', {'challengeToken': challenge, 'code': cm_2fa.totp(self.secret, self.step)}, token='')[0], 400)
        self.assertEqual(self.request('disable', {'password': 'wrong', 'code': self.codes[0]})[0], 400)
        self.assertTrue(self.request('status')[1]['enabled'])
        self.assertEqual(self.request('disable', {'password': 'oldpass', 'code': self.codes[0]})[0], 200)
        self.assertFalse(self.request('status')[1]['enabled'])
        self.assertIsNone(cm_db.user_by_token(result['token']))
        status, r = self.call('POST', '/auth/login', {'username': 'alice', 'password': 'oldpass'})
        self.assertIn('token', r)

    def test_recovery_atomic_and_hashed(self):
        self.setup_factor()
        challenge = self.challenge()
        def complete(_):
            try:
                cm_2fa.complete(challenge, self.codes[0])
                return True
            except cm_2fa.Error:
                return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sum(pool.map(complete, range(2))), 1)
        self.assertEqual(self.request('status')[1]['recoveryCodesRemaining'], 9)
        with open(cm_db.DB_PATH, 'rb') as database:
            self.assertNotIn(self.codes[0], database.read().decode('latin1'))
        c = self.challenge()
        self.assertEqual(self.request('login', {'challengeToken': c, 'code': self.codes[0]}, token='')[0], 400)

    def test_limit_survives_new_challenge(self):
        self.setup_factor()
        c = self.challenge()
        for _ in range(5):
            self.assertEqual(self.request('login', {'challengeToken': c, 'code': 'bad'}, token='')[0], 400)
        self.assertEqual(self.request('login', {'challengeToken': c, 'code': self.codes[0]}, token='')[0], 429)
        status, _ = self.call('POST', '/auth/login', {'username': 'alice', 'password': 'oldpass'})
        self.assertEqual(status, 429)

    def test_expiration_and_session_binding(self):
        self.assertEqual(self.request('setup', {'password': 'wrong'})[0], 400)
        self.assertEqual(self.request('setup', {'password': 'oldpass'}, token='')[0], 401)
        _, data = self.request('setup', {'password': 'oldpass'})
        code = cm_2fa.totp(data['secret'], int(time.time()) // 30)
        self.assertEqual(self.request('enable', {'code': code}, token=self.other)[0], 400)
        with mock.patch.object(cm_2fa.time, 'time', return_value=time.time() + 601):
            self.assertEqual(self.request('enable', {'code': code})[0], 400)
        self.assertFalse(self.request('status')[1]['enabled'])
        self.setup_factor()
        c = self.challenge()
        with mock.patch.object(cm_2fa.time, 'time', return_value=time.time() + 301):
            self.assertEqual(self.request('login', {'challengeToken': c, 'code': self.codes[0]}, token='')[0], 400)

    def test_email_login_and_password_reset_cannot_bypass(self):
        self.setup_factor()
        cm_db.save_email_code('login:alice@example.com', '123456', 300)
        status, r = self.call('POST', '/auth/login/email', {'email': 'alice@example.com', 'code': '123456'})
        self.assertEqual(status, 200, r)
        self.assertTrue(r['requires2FA'])
        self.assertNotIn('token', r)
        cm_db.set_password(self.uid, 'newpass')
        self.assertEqual(self.request('login', {'challengeToken': r['challengeToken'], 'code': self.codes[0]}, token='')[0], 400)
        self.assertTrue(self.request('status')[1]['enabled'])

    def test_disabled_user_and_rotated_challenge(self):
        self.setup_factor()
        c = self.challenge()
        c2 = self.challenge()
        self.assertEqual(self.request('login', {'challengeToken': c, 'code': self.codes[0]}, token='')[0], 400)
        conn = cm_db.connect()
        conn.execute('UPDATE users SET disabled=1 WHERE id=?', (self.uid,))
        conn.commit(); conn.close()
        self.assertEqual(self.request('login', {'challengeToken': c2, 'code': self.codes[0]}, token='')[0], 400)


if __name__ == '__main__':
    unittest.main()
