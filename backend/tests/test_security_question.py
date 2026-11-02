"""Login security questions: isolated DB, exclusive protection, no mail/network."""
import concurrent.futures
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import test_password_reset as harness
import cm_2fa
import cm_db
import cm_server


class TestSecurityQuestion(unittest.TestCase):
    call = harness.TestPasswordReset.call
    make_user = harness.TestPasswordReset.make_user
    _cleanup = harness.TestPasswordReset._cleanup

    def setUp(self):
        harness.TestPasswordReset.setUp(self)
        self.patch = mock.patch.object(cm_server.cm_region, 'note')
        self.patch.start(); self.addCleanup(self.patch.stop)
        self.uid = self.make_user()
        self.token = cm_db.issue_token(self.uid, 'current')
        self.other = cm_db.issue_token(self.uid, 'other')
        self.question = '只有我知道的旅行代号是什么？'
        self.answer = 'Private Answer 123'

    def request(self, method, body=None, token=None, path='/auth/security-question'):
        return self.call(method, path, body, self.token if token is None else token)

    def enable(self):
        status, data = self.request('POST', {'password': 'oldpass', 'question': self.question, 'answer': self.answer})
        self.assertEqual(status, 200, data)

    def login(self):
        status, data = self.call('POST', '/auth/login', {'username': 'alice', 'password': 'oldpass'})
        self.assertEqual(status, 200, data)
        self.assertTrue(data['requiresSecurityQuestion'])
        self.assertFalse(data['requires2FA'])
        self.assertNotIn('token', data)
        self.assertNotIn('user', data)
        self.assertEqual(data['securityQuestion'], self.question)
        self.assertIsNone(cm_db.user_by_token(data['challengeToken']))
        return data['challengeToken']

    def complete(self, token, answer=None):
        return self.request('POST', {'challengeToken': token, 'answer': self.answer if answer is None else answer}, token='', path='/auth/security-question/login')

    def test_enable_status_no_answer_and_revoke_other_sessions(self):
        self.enable()
        self.assertIsNotNone(cm_db.user_by_token(self.token))
        self.assertIsNone(cm_db.user_by_token(self.other))
        status, data = self.request('GET')
        self.assertEqual(status, 200)
        self.assertEqual(data, {'enabled': True, 'question': self.question, 'twoFactorEnabled': False})
        self.assertNotIn(self.answer, json.dumps(data))
        conn = cm_db.connect()
        try:
            row = dict(conn.execute('SELECT * FROM account_security_questions').fetchone())
        finally:
            conn.close()
        self.assertNotIn(self.answer, json.dumps(row))
        self.assertEqual(row['answer_hash'], cm_db.hash_password('private answer 123', row['salt']))

    def test_login_normalization_retry_and_single_use(self):
        self.enable(); token = self.login()
        self.assertEqual(self.complete(token, 'wrong answer')[0], 400)
        # Full-width and case differences do not lock the user out.
        status, data = self.complete(token, '  ＰＲＩＶＡＴＥ ＡＮＳＷＥＲ １２３  ')
        self.assertEqual(status, 200, data)
        self.assertIsNotNone(cm_db.user_by_token(data['token']))
        self.assertEqual(self.complete(token)[0], 400)

    def test_email_and_internal_login_require_question(self):
        self.enable()
        cm_db.save_email_code('login:alice@example.com', '123456', 300)
        status, data = self.call('POST', '/auth/login/email', {'email': 'alice@example.com', 'code': '123456'})
        self.assertEqual(status, 200, data); self.assertTrue(data['requiresSecurityQuestion']); self.assertNotIn('token', data)
        uid = cm_db.create_user('__internal__', 'internal-db-password', '内部', '__internal__@local')
        token = cm_db.issue_token(uid)
        cm_2fa.enable_question(uid, token, 'internal-db-password', '内部账号的专用问题？', 'answer-for-internal')
        with mock.patch.dict(os.environ, {'CM_INTERNAL_PASS': 'shared-pass'}):
            status, data = self.call('POST', '/auth/internal', {'password': 'shared-pass'})
        self.assertEqual(status, 200, data); self.assertTrue(data['requiresSecurityQuestion']); self.assertNotIn('token', data)

    def test_cannot_replace_without_old_answer_and_disable(self):
        self.enable(); challenge = self.login()
        self.assertEqual(self.request('POST', {'password': 'oldpass', 'question': '试图更换的新问题？', 'answer': 'new-answer'})[0], 409)
        self.assertEqual(self.request('DELETE', {'password': 'oldpass', 'answer': 'wrong'})[0], 400)
        self.assertEqual(self.request('DELETE', {'password': 'wrong', 'answer': self.answer})[0], 400)
        self.assertTrue(self.request('GET')[1]['enabled'])
        self.assertEqual(self.request('DELETE', {'password': 'oldpass', 'answer': self.answer})[0], 200)
        self.assertEqual(self.complete(challenge)[0], 400)
        status, data = self.call('POST', '/auth/login', {'username': 'alice', 'password': 'oldpass'})
        self.assertEqual(status, 200); self.assertIn('token', data)

    def test_exclusive_both_directions_and_pending_binding(self):
        setup = cm_2fa.setup(self.uid, self.token, 'oldpass')
        self.enable()
        for action in [lambda: cm_2fa.setup(self.uid, self.token, 'oldpass'), lambda: cm_2fa.enable(self.uid, self.token, '000000')]:
            with self.assertRaises(cm_2fa.Error) as error: action()
            self.assertEqual(error.exception.status, 409)
        cm_2fa.disable_question(self.uid, self.token, 'oldpass', self.answer)
        setup = cm_2fa.setup(self.uid, self.token, 'oldpass')
        result = cm_2fa.enable(self.uid, self.token, cm_2fa.totp(setup['secret'], int(cm_2fa.time.time()) // 30))
        self.assertEqual(self.request('POST', {'password': 'oldpass', 'question': self.question, 'answer': self.answer})[0], 409)
        cm_2fa.disable(self.uid, self.token, 'oldpass', result['recoveryCodes'][0])
        self.enable()

    def test_atomic_concurrent_enable_only_one_method(self):
        setup = cm_2fa.setup(self.uid, self.token, 'oldpass')
        def enable_method(kind):
            try:
                if kind == 'question': cm_2fa.enable_question(self.uid, self.token, 'oldpass', self.question, self.answer)
                else: cm_2fa.enable(self.uid, self.token, cm_2fa.totp(setup['secret'], int(cm_2fa.time.time()) // 30))
                return True
            except cm_2fa.Error: return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sum(pool.map(enable_method, ['question', 'totp'])), 1)
        state = cm_2fa.status(self.uid)
        self.assertNotEqual(state['enabled'], state['securityQuestionEnabled'])

    def test_wrong_endpoint_expiry_and_reset_do_not_bypass(self):
        self.enable(); token = self.login()
        status, _ = self.call('POST', '/auth/2fa/login', {'challengeToken': token, 'code': self.answer})
        self.assertEqual(status, 400)
        with mock.patch.object(cm_2fa.time, 'time', return_value=cm_2fa.time.time() + 301):
            self.assertEqual(self.complete(token)[0], 400)
        token = self.login(); cm_db.set_password(self.uid, 'newpass')
        self.assertEqual(self.complete(token)[0], 400)
        self.assertTrue(self.request('GET')[1]['enabled'])

    def test_failures_survive_new_challenge_and_concurrent_login(self):
        self.enable(); token = self.login()
        for _ in range(5): self.assertEqual(self.complete(token, 'wrong')[0], 400)
        self.assertEqual(self.complete(token)[0], 429)
        self.assertEqual(self.call('POST', '/auth/login', {'username': 'alice', 'password': 'oldpass'})[0], 429)
        with mock.patch.object(cm_2fa.time, 'time', return_value=cm_2fa.time.time() + 301):
            token = self.login()
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                statuses = list(pool.map(lambda _: self.complete(token)[0], range(2)))
            self.assertEqual(sorted(statuses), [200, 400])

    def test_validation_authentication_and_no_public_question_lookup(self):
        self.assertEqual(self.request('GET', token='')[0], 401)
        for q, answer in [('短', 'answer'), ('正常的密保问题？', 'x'), ('控制\n字符', 'answer')]:
            self.assertEqual(self.request('POST', {'password': 'oldpass', 'question': q, 'answer': answer})[0], 400)
        self.assertEqual(self.request('POST', {'password': 'wrong', 'question': self.question, 'answer': self.answer})[0], 400)
        self.assertFalse(self.request('GET')[1]['enabled'])
        self.enable()
        status, data = self.call('POST', '/auth/login', {'username': 'alice', 'password': 'wrong'})
        self.assertEqual(status, 401); self.assertNotIn('securityQuestion', data)


if __name__ == '__main__': unittest.main()
