#!/usr/bin/env python3
"""聊天「引用消息」与「@全体成员」回归测试（临时库）。

覆盖：quote 列落库并在列表/SSE 输出里解析出摘要、软删后的引用目标不可再引用、
已发消息的引用在原消息删除后仍可读（软删行保留）、mentionAll 标记随消息下发。
权限（管理员专属）与「内容必须包含 @全体成员」由路由层校验，这里只测数据层。
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_chat  # noqa: E402
import cm_db    # noqa: E402


class TestChatQuoteAndMentionAll(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = cm_db.DB_PATH
        cm_db.DB_PATH = os.path.join(self.tmp.name, "test.db")
        cm_db.init()
        conn = cm_db.connect()
        try:
            cm_chat.init_chat_tables(conn)
            conn.commit()
        finally:
            conn.close()
        self.uid = cm_db.create_user("quote_user", "password123", "引用测试员")
        self.other = cm_db.create_user("quote_other", "password123", "路人")
        self.user = self.fetch(self.uid)
        self.user2 = self.fetch(self.other)

    def fetch(self, uid):
        conn = cm_db.connect()
        try:
            r = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
            return {k: r[k] for k in r.keys()}
        finally:
            conn.close()

    def tearDown(self):
        cm_db.DB_PATH = self.old
        self.tmp.cleanup()

    def test_send_with_quote_resolves_summary(self):
        m1 = cm_chat.send(self.user, "被引用的原文", "", [])
        m2 = cm_chat.send(self.user2, "有理有据", "", [], quote=m1["id"])
        self.assertEqual(m2["quote"]["id"], m1["id"])
        self.assertEqual(m2["quote"]["nickname"], "引用测试员")
        self.assertEqual(m2["quote"]["excerpt"], "被引用的原文")
        self.assertFalse(m2["mentionAll"])
        # 历史接口同样带出
        lst = cm_chat.list_messages()
        self.assertEqual(lst[-1]["quote"]["excerpt"], "被引用的原文")
        self.assertEqual(lst[0]["quote"], None)

    def test_quote_without_target_is_null(self):
        m = cm_chat.send(self.user, "普通消息", "", [], quote=0)
        self.assertIsNone(m["quote"])
        # 引用不存在的 id：数据层不拦（路由层 400），输出里找不到摘要则为 null
        m2 = cm_chat.send(self.user, "悬空引用", "", [], quote=424242)
        self.assertIsNone(m2["quote"])

    def test_deleted_message_not_quotable_but_old_quotes_still_resolve(self):
        m1 = cm_chat.send(self.user, "马上删", "", [])
        self.assertTrue(cm_chat.quote_exists(m1["id"]))
        m2 = cm_chat.send(self.user2, "先引用再说", "", [], quote=m1["id"])
        cm_chat.delete_message(m1["id"], self.user)
        # 已删除的消息不能再被引用（路由层据此 400）
        self.assertFalse(cm_chat.quote_exists(m1["id"]))
        # 但已发出去的引用仍能显示摘要（软删行保留在库里）
        lst = cm_chat.list_messages()
        self.assertEqual(lst[-1]["id"], m2["id"])
        self.assertEqual(lst[-1]["quote"]["excerpt"], "马上删")

    def test_mention_all_flag_roundtrip(self):
        m = cm_chat.send(self.user, "通知：@全体成员 开饭了", "", [], mention_all=True)
        self.assertTrue(m["mentionAll"])
        lst = cm_chat.list_messages()
        self.assertTrue(lst[-1]["mentionAll"])
        self.assertFalse(lst[-1]["mentions"])          # @全体成员 不占个人提及位
        m2 = cm_chat.send(self.user2, "普通发言", "", [])
        self.assertFalse(m2["mentionAll"])

    def test_ai_streaming_send_keeps_default_fields(self):
        # AI 占位消息走 streaming=True：不应带引用/全体标记
        m = cm_chat.send(self.user, "", "", [], [], streaming=True)
        self.assertTrue(m["streaming"])
        self.assertIsNone(m["quote"])
        self.assertFalse(m["mentionAll"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
