import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cm_db
import cm_ncm
import cm_server
from test_password_reset import _Handler


class TestCommentAPI(unittest.TestCase):
    def setUp(self):
        temp = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(patch.object(cm_db, 'DB_PATH', os.path.join(temp, 'comments.db')))
        cm_db.init()
        cm_server._rl_buckets.clear()

    def session(self, name, ncm_uid):
        uid = cm_db.create_user('comment_' + name, 'test-password', name)
        cm_db.save_binding(uid, f'fixture-cookie-{name}', ncm_uid)
        return cm_db.issue_token(uid)

    def request(self, path, body=None, token=''):
        method = 'GET' if body is None else 'POST'
        handler = _Handler(method, path, body=body, token=token)
        response_headers = {}
        handler.send_header = response_headers.__setitem__
        cm_server.Handler._dispatch(handler, method)
        return handler.status, json.loads(handler.wfile.getvalue()), response_headers

    def test_sort_mapping_and_latest_cursor(self):
        route = '/ncm/comments/page?id=42&limit=2'
        raw = {'code': 200, 'data': {'totalCount': 3, 'hasMore': True, 'cursor': '171234',
               'comments': [{'commentId': 9007199254740993, 'liked': True, 'likedCount': 89,
                             'showFloorComment': {'replyCount': 2}}]}}
        with patch.object(cm_ncm, 'call', return_value=raw) as upstream:
            for sort, expected in cm_ncm.COMMENT_SORTS.items():
                status, data, headers = self.request(route + '&sort=' + sort)
                self.assertEqual(status, 200)
                self.assertEqual(headers['Cache-Control'], 'private, no-store')
                self.assertEqual(data['total'], 3)
                self.assertEqual(data['comments'][0]['id'], '9007199254740993')
                self.assertEqual(data['comments'][0]['replyCount'], 2)
                self.assertFalse(data['comments'][0]['likedByMe'])
                self.assertEqual(upstream.call_args.args[1]['sortType'], expected)
                self.assertFalse(upstream.call_args.kwargs['with_cookie'])
            self.assertEqual(data['nextCursor'], '171234')
            status, data, _ = self.request(route + '&sort=latest&page=2&cursor=171234')
            self.assertEqual(status, 200)
            self.assertEqual(upstream.call_args.args[1]['cursor'], '171234')
            self.assertFalse(data['more'], 'a repeated upstream cursor terminates pagination')
            self.assertEqual(self.request(route + '&sort=latest&page=2')[0], 400)
            self.assertEqual(self.request(route + '&sort=wrong')[0], 400)

    def test_floor_excludes_parent_only_and_passes_time_cursor(self):
        path = '/ncm/comments/replies?type=6&id=A_EV_2_12_34&commentId=10&cursor=170001'
        raw = {'code': 200, 'data': {'ownerComment': {'commentId': 10}, 'totalCount': 2,
               'comments': [{'commentId': 11}, {'commentId': 10}, {'commentId': 12}],
               'hasMore': True, 'time': 170002}}
        with patch.object(cm_ncm, 'call', return_value=raw) as upstream:
            status, data, _ = self.request(path)
            self.assertEqual(status, 200)
            self.assertEqual(upstream.call_args.args, ('/comment/floor', {
                'id': '12_34', 'type': 6, 'parentCommentId': '10', 'limit': 20, 'time': '170001'}))
            self.assertEqual([row['id'] for row in data['comments']], ['11', '12'])
            self.assertEqual(data['nextCursor'], '170002')
            self.assertEqual(self.request('/ncm/comments/replies?type=6&id=12_34&commentId=10')[0], 400)

    def test_bound_likes_are_isolated_and_expired_binding_falls_back(self):
        path = '/ncm/comments/page?id=42'
        a, b = self.session('a', 100), self.session('b', 200)

        def upstream(_path, _params, *, cookie, with_cookie, bypass_cache):
            self.assertFalse(with_cookie)
            self.assertEqual(bypass_cache, cookie is not None)
            return {'code': 200, 'data': {'comments': [{'commentId': 11, 'liked': cookie != 'fixture-cookie-b'}]}}

        with patch.object(cm_ncm, 'call', side_effect=upstream):
            for token, uid, liked in ((a, 100, True), (b, 200, False), ('', 0, False)):
                status, data, _ = self.request(path, token=token)
                self.assertEqual((status, data['meUid'], data['comments'][0]['likedByMe']), (200, uid, liked))
        with patch.object(cm_ncm, 'call', side_effect=[{'code': 301}, upstream('', {}, cookie=None, with_cookie=False, bypass_cache=False)]) as call:
            status, data, _ = self.request(path, token=a)
            self.assertEqual((status, data['meUid'], data['comments'][0]['likedByMe']), (200, 0, False))
            self.assertIsNone(call.call_args.kwargs['cookie'])

    def test_json_writes_confirm_bind_and_preserve_action_direction(self):
        path = '/ncm/comment/like'
        token = self.session('write', 100)
        payload = {'type': 0, 'id': '42', 'cid': '11', 't': 1, 'confirm': 1,
                   'cookie': 'ignored', 'realIP': '203.0.113.25'}
        with patch.object(cm_ncm, 'post_json', return_value={'code': 200}) as upstream:
            self.assertEqual(self.request(path, payload)[0], 401)
            self.assertEqual(self.request(path, dict(payload, confirm=0), token)[0], 400)
            self.assertEqual(self.request(path, dict(payload, t=2), token)[0], 400)
            upstream.assert_not_called()
            for action in (1, 0):
                self.assertEqual(self.request(path, dict(payload, t=action), token)[0], 200)
                self.assertEqual(upstream.call_args.args, ('/comment/like', {
                    'type': '0', 'id': '42', 'cid': '11', 't': str(action), 'realIP': '10.0.0.1'}))
                self.assertEqual(upstream.call_args.kwargs, {'cookie': 'fixture-cookie-write'})
            reply = {'type': 6, 'threadId': 'A_EV_2_12_34', 't': 2, 'commentId': '11', 'content': ' 回复 ', 'confirm': 1}
            self.assertEqual(self.request('/ncm/comment', reply, token)[0], 200)
            self.assertEqual(upstream.call_args.args[1]['threadId'], 'A_EV_2_12_34')
            self.assertEqual(upstream.call_args.args[1]['content'], '回复')
            upstream.return_value = {'code': 400, 'message': '操作失败'}
            self.assertEqual(self.request(path, payload, token)[:2], (502, {'error': '操作失败'}))
