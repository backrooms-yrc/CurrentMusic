#!/usr/bin/env python3
"""发现页用户置顶 + 管理台用户排序回归测试。"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_db  # noqa: E402


class TestSquarePinAndAdminSort(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = cm_db.DB_PATH
        cm_db.DB_PATH = os.path.join(self.tmp.name, "test.db")
        cm_db.init()

    def tearDown(self):
        cm_db.DB_PATH = self.old
        self.tmp.cleanup()

    def test_rcst20_always_first_for_every_sort(self):
        pinned = cm_db.create_user("Rcst20", "password123", "ℝ𝕔𝕤𝕥𝟚𝟘")
        other = cm_db.create_user("bileizhen", "password123", "另一位站长")
        cm_db.set_owner(other, True)

        for sort in ("reg", "reg_asc", "name", "days", "listen", "likes"):
            d = cm_db.square_users(sort=sort, limit=10, offset=0)
            self.assertEqual(d["users"][0]["id"], pinned, sort)
            self.assertEqual(d["users"][0]["nickname"], "ℝ𝕔𝕤𝕥𝟚𝟘", sort)

        # 搜索不匹配时不强行插入置顶用户；过滤条件优先于置顶
        d = cm_db.square_users(query="bileizhen", limit=10, offset=0)
        self.assertNotIn(pinned, [u["id"] for u in d["users"]])
        # 不在听歌时，仅显示在听歌的过滤也不会强行塞入
        d = cm_db.square_users(listening_only=True, limit=10, offset=0)
        self.assertNotIn(pinned, [u["id"] for u in d["users"]])

    def test_admin_user_sort_whitelist(self):
        a = cm_db.create_user("aaa_admin_test", "password123", "A 用户")
        b = cm_db.create_user("bbb_admin_test", "password123", "B 用户")
        cm_db.toggle_like(b, 1)
        cm_db.toggle_like(b, 2)

        d = cm_db.admin_list_users("", 20, 0, "likes")
        self.assertEqual(d["users"][0]["id"], b)
        d = cm_db.admin_list_users("", 20, 0, "reg_asc")
        self.assertEqual(d["users"][0]["id"], a)
        d = cm_db.admin_list_users("", 20, 0, "name")
        self.assertEqual(d["users"][0]["id"], a)
        d = cm_db.admin_list_users("", 20, 0, "not-a-sort")
        self.assertEqual(d["users"][0]["id"], b)   # 非法排序回落到注册最新


if __name__ == "__main__":
    unittest.main(verbosity=2)
