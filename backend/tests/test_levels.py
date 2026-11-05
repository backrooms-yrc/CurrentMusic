"""活跃积分、管理台修改、发现排序与试炼 API 的回归测试。"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
import tempfile
import unittest
from unittest import mock

from test_password_reset import _Handler
import cm_db
import cm_levels
import cm_server


class UserLevelsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.enterContext(mock.patch.object(cm_db, "DB_PATH", os.path.join(tmp.name, "test.db")))
        self.enterContext(mock.patch.object(cm_server.cm_region, "note"))
        cm_db.init()
        self.user = cm_db.create_user("leveluser", "password123", "试炼用户")
        self.token = cm_db.issue_token(self.user)

    def request(self, method, path, body=None, token=None):
        h = _Handler(method, path, body, token=token or "")
        try:
            cm_server.route(h, method)
        except cm_server.ApiError as e:
            return e.code, {"error": e.msg}
        return h.status, json.loads(h.wfile.getvalue())

    def test_daily_points_across_devices_and_beijing_midnight(self):
        other = cm_db.issue_token(self.user)
        cm_db.set_progression(self.user, 40, 1)
        midnight = datetime(2026, 11, 6, tzinfo=timezone(timedelta(hours=8))).timestamp()
        with mock.patch.object(cm_db.time, "time", return_value=midnight - 1):
            with ThreadPoolExecutor(max_workers=2) as pool:
                users = list(pool.map(cm_db.user_by_token, [self.token, other]))
            self.assertEqual([(u["points"], u["level"]) for u in users], [(50, 2), (50, 2)])
        # 跨零点仅 1 秒，仍计入新一天。
        with mock.patch.object(cm_db.time, "time", return_value=midnight):
            u = cm_db.user_by_token(self.token)
            self.assertEqual((u["points"], u["level"]), (60, 2))
            cm_db.set_progression(self.user, 610, 2)
            self.assertEqual(cm_db.user_by_token(other)["points"], 610)
        # 管理员设定的等级保留，直到用户跨过新的门槛。
        with mock.patch.object(cm_db.time, "time", return_value=midnight + 86400):
            u = cm_db.user_by_token(self.token)
            self.assertEqual((u["points"], u["level"]), (620, 2))

    def test_trial_and_admin_api(self):
        path = f"/admin/users/{self.user}/progression"
        self.assertEqual(self.request("GET", "/levels/trial")[0], 401)
        self.assertEqual(self.request("GET", "/levels/trial", token=self.token)[0], 403)
        self.assertEqual(self.request("POST", path, {"level": 6, "points": 1000}, self.token)[0], 403)
        admin = cm_db.create_user("levelsadmin", "password123", "管理")
        cm_db.set_admin(admin, True)
        token = cm_db.issue_token(admin)
        self.assertEqual(self.request("POST", path, {"level": 6, "points": True}, token)[0], 400)
        self.assertEqual(self.request("POST", path, {"level": 6, "points": 1000}, token)[0], 200)
        _, data = self.request("GET", "/levels/trial", token=self.token)
        self.assertEqual(len(data["questions"]), 10)
        self.assertEqual(set(data["questions"][0]), {"prompt", "options"})
        answers = [correct for _, _, correct in cm_levels.QUESTIONS]
        self.assertEqual(self.request("POST", "/levels/trial", {"answers": [False] * 10}, self.token)[0], 400)
        wrong = [(i + 1) % 3 for i in answers]
        status, grade = self.request("POST", "/levels/trial", {"answers": answers[:5] + wrong[5:]}, self.token)
        self.assertEqual((status, grade), (200, {"score": 50, "passed": False, "level": 6}))
        for _ in range(2):
            status, grade = self.request("POST", "/levels/trial", {"answers": answers[:6] + wrong[6:]}, self.token)
            self.assertEqual((status, grade), (200, {"score": 60, "passed": True, "level": 7}))
        self.assertEqual(self.request("GET", "/levels/trial", token=self.token)[0], 409)
        _, me = self.request("GET", "/auth/me", token=self.token)
        self.assertEqual((me["points"], me["level"]), (1000, 7))

    def test_listen_points_require_elapsed_time_and_deduplicate_progress(self):
        start = int(datetime(2026, 11, 6, 12, tzinfo=timezone(timedelta(hours=8))).timestamp())
        cm_db.set_progression(self.user, 48, 1)
        with mock.patch.object(cm_db.time, "time", return_value=start):
            play_ids = {song: cm_db.record_play(self.user, song) for song in range(1, 7)}
            self.assertTrue(cm_db.update_play_total(self.user, 1, play_ids[1], 60_000))
            self.assertEqual(cm_db.point_progress(self.user)["points"], 48)
        with mock.patch.object(cm_db.time, "time", return_value=start + 60):
            self.assertFalse(cm_db.update_play_total(self.user, 2, play_ids[1], 60_000))
            with ThreadPoolExecutor(max_workers=2) as pool:
                list(pool.map(lambda _: cm_db.update_play_total(self.user, 1, play_ids[1], 60_000), range(2)))
            self.assertEqual(cm_db.add_play_ms(self.user, 1, 60_000), 60_000)
            self.assertEqual(cm_db.point_progress(self.user), {
                "level": 2, "points": 50, "today": {"visit": 0, "listen": 1, "post": 0, "comment": 0},
            })
            for song in range(2, 7):
                cm_db.add_play_ms(self.user, song, 59_999)
                cm_db.add_play_ms(self.user, song, 1)
            self.assertEqual(cm_db.point_progress(self.user)["today"]["listen"], 5)
            self.assertEqual(cm_db.point_progress(self.user)["points"], 58)
        with mock.patch.object(cm_db.time, "time", return_value=start + 86400):
            cm_db.update_play_total(self.user, 1, play_ids[1], 65_000)
            self.assertEqual(cm_db.point_progress(self.user)["today"]["listen"], 0)
            replay = cm_db.record_play(self.user, 1)
        with mock.patch.object(cm_db.time, "time", return_value=start + 86460):
            cm_db.update_play_total(self.user, 1, replay, 60_000)
            self.assertEqual(cm_db.point_progress(self.user)["points"], 60)

    def test_progress_reports_daily_post_and_comment_caps(self):
        self.assertEqual(self.request("GET", "/levels/progress")[0], 401)
        status, rules = self.request("GET", "/levels/rules")
        self.assertEqual(status, 200)
        self.assertEqual(sum(src["points"] * src["dailyLimit"] for src in rules["pointSources"]), 29)
        other = cm_db.create_user("postauthor", "password123", "发帖者")
        own = cm_db.post_create(self.user, "自己的帖子", [])
        cm_db.post_delete(self.user, own)
        own = cm_db.post_create(self.user, "再次发帖", [])
        cm_db.post_comment_add(self.user, own, "自评")
        posts = [cm_db.post_create(other, f"帖子 {i}", []) for i in range(3)]
        comment = cm_db.post_comment_add(self.user, posts[0], "评论")
        cm_db.post_comment_delete(self.user, comment)
        cm_db.post_comment_add(self.user, posts[0], "重复评论")
        self.assertEqual(cm_db.point_progress(self.user)["points"], 7)
        for post in posts[1:]:
            cm_db.post_comment_add(self.user, post, "评论")
        status, progress = self.request("GET", "/levels/progress", token=self.token)
        self.assertEqual((status, progress), (200, {
            "level": 1, "points": 19, "today": {"visit": 1, "listen": 0, "post": 1, "comment": 2},
        }))

    def test_square_sort_orders(self):
        second = cm_db.create_user("second", "password123", "Second")
        third = cm_db.create_user("third", "password123", "Third")
        cm_db.set_progression(self.user, 2000, 6)
        cm_db.set_progression(second, 1000, 6)
        cm_db.set_progression(third, 1000, 7)
        conn = cm_db.connect()
        self.addCleanup(conn.close)
        with conn:
            conn.execute("UPDATE users SET activity_at=10000000000 WHERE id=?", (second,))
        for suffix, expected in (
            ("", [third, self.user, second]),
            ("?sort=active", [second, self.user, third]),
            ("?sort=level", [third, second, self.user]),
            ("?sort=unknown", [third, self.user, second]),
        ):
            status, data = self.request("GET", "/users/square" + suffix)
            self.assertEqual(status, 200)
            self.assertEqual([u["id"] for u in data["users"]], expected)
            self.assertNotIn("points", data["users"][0])
