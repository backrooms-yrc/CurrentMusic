import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cm_db  # noqa: E402


class TestAdminOverviewLikes(unittest.TestCase):
    def setUp(self):
        # 用临时库：这组用例会造用户/点赞/歌单，绝不能写进线上库。
        self._tmp = tempfile.TemporaryDirectory()
        self._old_db = cm_db.DB_PATH
        cm_db.DB_PATH = os.path.join(self._tmp.name, "test.db")
        cm_db.init()

    def tearDown(self):
        cm_db.DB_PATH = self._old_db
        self._tmp.cleanup()

    def test_total_like_breakdown(self):
        u = cm_db.create_user("like_stats_test", "password123", "点赞统计")
        cm_db.toggle_like(u, 1001)
        cm_db.toggle_like(u, 1002)
        cm_db.save_binding(u, "cookie", 4242)
        cm_db.set_binding_liked_pl(u, 777)
        pid = cm_db.create_playlist(u, "我喜欢的音乐", source="ncm", ncm_pl_id=777)
        cm_db.playlist_add_tracks(pid, [1003, 1004, 1004, 1005])
        # 同用户重复同步出第二个「我喜欢的音乐」：按 (用户, 歌曲) 去重，不应重复计数
        pid2 = cm_db.create_playlist(u, "我喜欢的音乐(旧)", source="ncm", ncm_pl_id=777)
        cm_db.playlist_add_tracks(pid2, [1004, 1006])

        ov = cm_db.admin_overview()
        self.assertEqual(ov["likes"], 2)
        self.assertEqual(ov["ncmLikes"], 4)          # 1003/1004/1005/1006
        self.assertEqual(ov["likes"] + ov["ncmLikes"], 6)

    def test_admin_user_search(self):
        cm_db.create_user("alice", "password123", "爱丽丝", "alice@example.com")
        cm_db.create_user("bob", "password123", "鲍勃", "bob@example.com")
        d = cm_db.admin_list_users("ali", 20, 0)
        self.assertEqual(d["total"], 1)
        self.assertEqual(d["users"][0]["username"], "alice")
        d = cm_db.admin_list_users("bob@", 20, 0)
        self.assertEqual(d["total"], 1)
        self.assertEqual(d["users"][0]["username"], "bob")

    def test_admin_user_avatar_fields(self):
        uid = cm_db.create_user("avatar_test", "password123", "头像测试", "avatar@example.com")
        cm_db.update_profile(uid, {"avatar": "abc123.png"})
        cm_db.set_avatar_decoration(uid, "decor-test")
        d = cm_db.admin_list_users("avatar_test", 20, 0)
        self.assertEqual(d["users"][0]["avatar"], "abc123.png")
        self.assertEqual(d["users"][0]["avatarDecoration"], "decor-test")

    def test_chart_series_and_role_breakdown(self):
        u = cm_db.create_user("chart_stats_test", "password123", "图表统计")
        cm_db.record_play(u, 2001)

        ov = cm_db.admin_overview()
        # 图表序列固定长度、日期连续补零，前端不需要猜断档/时区
        self.assertEqual(len(ov["userDaily"]), 30)
        self.assertEqual(len(ov["playDaily"]), 14)
        self.assertEqual(sum(x["count"] for x in ov["userDaily"]), 1)
        self.assertEqual(sum(x["plays"] for x in ov["playDaily"]), 1)
        self.assertEqual(ov["userDaily"][-1]["day"], ov["playDaily"][-1]["day"])
        # 角色四档互不重叠，合计等于总用户数
        self.assertEqual(sum(ov["roleCounts"].values()), ov["users"])
        self.assertEqual(ov["roleCounts"]["user"], 1)


if __name__ == "__main__":
    unittest.main()
