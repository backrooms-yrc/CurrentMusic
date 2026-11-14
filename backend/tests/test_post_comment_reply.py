#!/usr/bin/env python3
"""帖子评论区「回复」回归测试（临时库）。

覆盖：回复落库与列表带出 replyTo、跨帖/不存在的回复目标被拒、
被回复评论删除后该条按普通评论展示（replyTo=null）。
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_db  # noqa: E402


class TestPostCommentReply(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = cm_db.DB_PATH
        cm_db.DB_PATH = os.path.join(self.tmp.name, "test.db")
        cm_db.init()
        self.u1 = cm_db.create_user("reply_author", "password123", "楼主")
        self.u2 = cm_db.create_user("reply_cmt", "password123", "评论者")
        self.u3 = cm_db.create_user("reply_re", "password123", "回复者")
        self.p1 = cm_db.post_create(self.u1, "第一条帖子", [])
        self.p2 = cm_db.post_create(self.u1, "第二条帖子", [])

    def tearDown(self):
        cm_db.DB_PATH = self.old
        self.tmp.cleanup()

    def test_reply_roundtrip(self):
        c1 = cm_db.post_comment_add(self.u2, self.p1, "好听得不行")
        c2 = cm_db.post_comment_add(self.u3, self.p1, "同意楼上", reply_to=c1)
        lst = cm_db.post_comments_list(self.p1)
        self.assertEqual(len(lst), 2)
        self.assertIsNone(lst[0]["replyTo"])                       # 普通评论无 replyTo
        self.assertEqual(lst[1]["id"], c2)
        self.assertEqual(lst[1]["replyTo"], {"id": c1, "userId": self.u2, "nickname": "评论者"})

    def test_reply_target_must_exist(self):
        with self.assertRaises(ValueError) as ctx:
            cm_db.post_comment_add(self.u3, self.p1, "回复谁？", reply_to=99999)
        self.assertEqual(str(ctx.exception), "回复的评论不存在")
        self.assertEqual(cm_db.posts_list(None)[0]["commentCount"], 0)   # 没有半条残留

    def test_reply_across_post_rejected(self):
        c1 = cm_db.post_comment_add(self.u2, self.p1, "这条属于帖子一")
        # 用帖子一的评论 id 去回复帖子二：必须拒绝，防止串帖展示
        with self.assertRaises(ValueError):
            cm_db.post_comment_add(self.u3, self.p2, "串门回复", reply_to=c1)

    def test_reply_shows_plain_after_parent_deleted(self):
        c1 = cm_db.post_comment_add(self.u2, self.p1, "即将被删的评论")
        cm_db.post_comment_add(self.u3, self.p1, "回复你", reply_to=c1)
        self.assertTrue(cm_db.post_comment_delete(self.u2, c1))
        lst = cm_db.post_comments_list(self.p1)
        self.assertEqual(len(lst), 1)
        self.assertIsNone(lst[0]["replyTo"])                       # 父评论没了：按普通评论展示

    def test_admin_can_delete_reply(self):
        c1 = cm_db.post_comment_add(self.u2, self.p1, "评论")
        c2 = cm_db.post_comment_add(self.u3, self.p1, "回复", reply_to=c1)
        # 楼主不是管理员也非作者：不能删
        self.assertFalse(cm_db.post_comment_delete(self.u1, c2))
        self.assertTrue(cm_db.post_comment_delete(self.u3, c2))    # 回复者本人可删


if __name__ == "__main__":
    unittest.main(verbosity=2)
