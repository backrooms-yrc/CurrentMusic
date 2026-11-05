import concurrent.futures
import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cm_db
import cm_server
import test_password_reset as harness


class SearchHistoryTests(unittest.TestCase):
    setUp = harness.TestPasswordReset.setUp
    _cleanup = harness.TestPasswordReset._cleanup
    call = harness.TestPasswordReset.call

    def user(self, name="history"):
        uid = cm_db.create_user(name, "fixture-password", name)
        return uid, cm_db.issue_token(uid, "device-a"), cm_db.issue_token(uid, "device-b")

    def test_two_devices_share_order_deduplication_and_limit(self):
        uid, a, b = self.user()
        for i in range(12):
            self.assertEqual(self.call("POST", "/search/history", {"keyword": f"歌曲 {i}"}, token=a)[0], 200)
        self.call("POST", "/search/history", {"keyword": "  歌曲 5  "}, token=b)
        expected = ["歌曲 5"] + [f"歌曲 {i}" for i in range(11, 1, -1) if i != 5]
        self.assertEqual(self.call("GET", "/search/history", token=a)[1]["history"], expected)
        self.assertEqual(self.call("GET", "/search/history", token=b)[1]["history"], expected)
        cm_db.init()
        self.assertEqual(cm_db.search_history(uid), expected)

    def test_account_isolation_auth_and_validation(self):
        _, a, _ = self.user()
        other, b, _ = self.user("other")
        self.call("POST", "/search/history", {"keyword": "仅第一个账号"}, token=a)
        self.assertEqual(self.call("GET", "/search/history", token=b)[1]["history"], [])
        for method, path, body in [("GET", "/search/history", None), ("POST", "/search/history", {"keyword": "x"}),
                                   ("DELETE", "/search/history", {}), ("POST", "/search/history/import", {"keywords": []})]:
            self.assertEqual(self.call(method, path, body)[0], 401)
        for keyword in (None, "", "  ", "x" * 201, 4, [], {}):
            self.assertEqual(self.call("POST", "/search/history", {"keyword": keyword}, token=a)[0], 400)
            self.assertEqual(self.call("DELETE", "/search/history", {"keyword": keyword}, token=a)[0], 400)
        self.assertEqual(self.call("POST", "/search/history", [], token=a)[0], 400)
        self.assertEqual(self.call("POST", "/search/history/import", {"keywords": ["x"] * 11}, token=a)[0], 400)
        self.assertEqual(self.call("POST", "/search/history/import", {"keywords": [None]}, token=a)[0], 400)
        self.call("DELETE", "/search/history", {"user_id": other}, token=a)
        self.assertEqual(cm_db.search_history(other), [])

    def test_remove_clear_and_import_cannot_resurrect_deleted_history(self):
        _, a, b = self.user()
        self.assertEqual(self.call("POST", "/search/history/import", {"keywords": ["新", "旧", "新"]}, token=a)[1]["history"], ["新", "旧"])
        self.assertEqual(self.call("DELETE", "/search/history", {"keyword": "新"}, token=b)[1]["history"], ["旧"])
        self.assertEqual(self.call("POST", "/search/history/import", {"keywords": ["新", "另一个设备"]}, token=a)[1]["history"], ["旧"])
        self.assertEqual(self.call("DELETE", "/search/history", {}, token=b)[1]["history"], [])
        self.assertEqual(self.call("POST", "/search/history/import", {"keywords": ["旧"]}, token=a)[1]["history"], [])
        self.assertEqual(self.call("POST", "/search/history", {"keyword": "之后的新搜索"}, token=a)[1]["history"], ["之后的新搜索"])

    def test_clear_before_first_import_stays_empty(self):
        _, a, _ = self.user()
        self.call("DELETE", "/search/history", {}, token=a)
        self.assertEqual(self.call("POST", "/search/history/import", {"keywords": ["旧设备缓存"]}, token=a)[1]["history"], [])

    def test_concurrent_devices_do_not_overwrite_each_other(self):
        uid, a, b = self.user()
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda i: self.call("POST", "/search/history", {"keyword": f"并发 {i}"}, token=a if i % 2 else b), range(8)))
        self.assertTrue(all(status == 200 for status, _ in results))
        self.assertEqual(set(cm_db.search_history(uid)), {f"并发 {i}" for i in range(8)})

    def test_responses_are_not_cacheable(self):
        _, token, _ = self.user()
        h = harness._Handler("GET", "/search/history", token=token)
        headers = {}
        h.send_header = lambda key, value: headers.update({key: value})
        cm_server.route(h, "GET")
        self.assertEqual(headers["Cache-Control"], "no-store")
