#!/usr/bin/env python3
"""网易云 /login/status 解析回归测试（v1.28.44 修订）。

背景：上游有两种响应形状——
    {code: 200, data: {profile: ...}}              （旧）
    {data: {code: 200, account: ..., profile: ...}}（新，当前线上）
旧实现只读顶层 code，第二种会得到 code=None → 判定「未登录」→ **所有有效绑定被标成
stale**，App / 第三方客户端据此以为用户没有同步网易云登录态。

    python3 -m unittest backend.tests.test_login_status -v
"""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_ncm  # noqa: E402


class TestParseLoginStatus(unittest.TestCase):
    def test_legacy_shape(self):
        d = {"code": 200, "data": {"profile": {"userId": 1, "nickname": "x"}}}
        out = cm_ncm.parse_login_status(d)
        self.assertEqual(out["code"], 200)
        self.assertTrue(out["ok"])

    def test_nested_shape_is_ok(self):
        """当前线上形状：code 在 data.code —— 绝不能误判为未登录。"""
        d = {"data": {"code": 200, "account": {"id": 1}, "profile": {"userId": 1, "nickname": "x"}}}
        out = cm_ncm.parse_login_status(d)
        self.assertEqual(out["code"], 200)
        self.assertTrue(out["ok"])
        self.assertEqual(out["data"]["profile"]["nickname"], "x")

    def test_expired_code(self):
        d = {"data": {"code": 301, "account": None, "profile": None}}
        out = cm_ncm.parse_login_status(d)
        self.assertEqual(out["code"], 301)
        self.assertFalse(out["ok"])

    def test_garbage(self):
        for d in (None, {}, {"data": {}}, {"data": {"code": 200}}):
            self.assertFalse(cm_ncm.parse_login_status(d)["ok"])


if __name__ == "__main__":
    unittest.main()
