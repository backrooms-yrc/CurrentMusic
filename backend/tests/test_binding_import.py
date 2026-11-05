import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cm_db
import cm_ncm
import cm_server
import cm_binding_import


class Handler:
    def __init__(self, path, body=None, token=''):
        raw = json.dumps(body).encode() if body is not None else b''
        self.path = path
        self.headers = {'Content-Length': str(len(raw)), 'Content-Type': 'application/json', 'Host': 'localhost'}
        if token:
            self.headers['Authorization'] = 'Bearer ' + token
        self.rfile, self.wfile = io.BytesIO(raw), io.BytesIO()
        self.client_address = ('127.0.0.1', 0)
        self.response_headers = {}
        self.status = 0
    def send_response(self, status): self.status = status
    def send_header(self, key, value): self.response_headers[key] = value
    def end_headers(self): pass


class BindingImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.patch = patch.object(cm_db, 'DB_PATH', str(Path(self.tmp.name) / 'test.db'))
        self.patch.start()
        cm_db.init()
        self.uid = cm_db.create_user('alice', 'password1', 'Alice')
        self.other = cm_db.create_user('bob', 'password2', 'Bob')
        self.token = cm_db.issue_token(self.uid)
        self.cookie = 'MUSIC_U=device-secret; __csrf=csrf-secret'
        self.body = {'cookie': self.cookie, 'expectedNcmUid': 42}
        self.upstream = patch.object(cm_ncm, 'call', return_value={
            'code': 200, 'profile': {'userId': 42, 'nickname': 'Cloud', 'avatarUrl': 'https://example.test/a.png'}})
        self.call = self.upstream.start()
        self.addCleanup(self.upstream.stop)
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.patch.stop)

    def request(self, body, token=None, method='POST', path='/ncmbind/import'):
        handler = Handler(path, body, self.token if token is None else token)
        try:
            cm_server.route(handler, method)
        except cm_server.ApiError as error:
            return error.code, {'error': error.msg}, handler.response_headers
        return handler.status, json.loads(handler.wfile.getvalue()), handler.response_headers

    def test_import_is_visible_to_other_session_without_exposing_cookie(self):
        status, data, headers = self.request(self.body)
        self.assertEqual(status, 200)
        self.assertEqual(data['profile']['uid'], 42)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertNotIn('secret', json.dumps(data))
        self.assertEqual(cm_db.get_binding(self.uid)['cookie'], self.cookie)
        status, result, _ = self.request(None, token=cm_db.issue_token(self.uid), method='GET', path='/ncmbind')
        self.assertEqual(status, 200)
        self.assertTrue(result['bound'])
        self.assertNotIn('secret', json.dumps(result))
        self.assertIsNone(cm_db.get_binding(self.other))

    def test_requires_currentmusic_authentication(self):
        self.assertEqual(self.request(self.body, token='')[0], 401)
        self.call.assert_not_called()

    def test_rejects_bad_input_before_contacting_upstream(self):
        for body in (None, [], {'cookie': self.cookie}, {'cookie': self.cookie, 'expectedNcmUid': True},
                     {'cookie': 'MUSIC_U=x\r\nHost: evil', 'expectedNcmUid': 42},
                     {'cookie': 'MUSIC_U=x; MUSIC_U=y', 'expectedNcmUid': 42},
                     {'cookie': 'MUSIC_U=' + 'x'*17000, 'expectedNcmUid': 42},
                     {'cookie': '__csrf=x', 'expectedNcmUid': 42},
                     {'cookie': 'MUSIC_U=x; os=android', 'expectedNcmUid': 42}):
            with self.subTest(body_type=type(body).__name__):
                self.assertEqual(self.request(body)[0], 400)
        self.call.assert_not_called()

    def test_invalid_or_mismatched_login_preserves_existing_binding(self):
        cm_db.save_binding(self.uid, 'MUSIC_U=existing', 99, 'Existing')
        self.assertEqual(self.request({**self.body, 'expectedNcmUid': 43})[0], 409)
        self.call.return_value = {'code': 301}
        self.assertEqual(self.request(self.body)[0], 401)
        self.assertEqual(cm_db.get_binding(self.uid)['ncm_uid'], 99)

    def test_errors_do_not_leak_credentials_or_expire_project_session(self):
        self.call.side_effect = cm_ncm.NcmError('URL cookie=MUSIC_U=device-secret')
        status, result, _ = self.request(self.body)
        self.assertEqual(status, 502)
        self.assertNotIn('secret', json.dumps(result))
        self.assertIsNotNone(cm_db.user_by_token(self.token))
        self.assertIsNone(cm_db.get_binding(self.uid))

    def test_same_account_keeps_sync_metadata_but_account_change_resets_it(self):
        cm_db.save_binding(self.uid, 'MUSIC_U=old', 42)
        conn = cm_db.connect()
        conn.execute('UPDATE ncm_bindings SET last_sync=100,last_sync_count=3,ncm_liked_pl_id=88 WHERE user_id=?', (self.uid,))
        conn.commit(); conn.close()
        cm_db.cache_set(f'nlikes:{self.uid}', '[99]', 100)
        cm_db.cache_set(f'nlikes:{self.uid}:42', '[99]', 100)
        self.assertEqual(self.request(self.body)[0], 200)
        self.assertEqual(cm_db.get_binding(self.uid)['ncm_liked_pl_id'], 88)
        self.assertIsNone(cm_db.cache_get(f'nlikes:{self.uid}'))
        self.assertIsNone(cm_db.cache_get(f'nlikes:{self.uid}:42'))
        self.call.return_value = {'code': 200, 'profile': {'userId': 43}}
        self.assertEqual(self.request({**self.body, 'expectedNcmUid': 43})[0], 200)
        binding = cm_db.get_binding(self.uid)
        self.assertEqual((binding['last_sync'], binding['last_sync_count'], binding['ncm_liked_pl_id']), (0, 0, 0))

    def test_bounded_verification_timeout_does_not_save(self):
        with patch.object(cm_ncm, '_run_with_wall_clock', return_value=cm_binding_import._IMPORT_TIMEOUT):
            self.assertEqual(self.request(self.body)[0], 502)
        self.assertIsNone(cm_db.get_binding(self.uid))
