#!/usr/bin/env python3
"""网易云短信发送错误映射测试。"""
from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cm_ncm  # noqa: E402


class TestNcmSmsErrors(unittest.TestCase):
    def test_business_code_400_is_client_error(self):
        with patch.object(cm_ncm, "call", return_value={
            "code": 400, "message": "当天发送验证码的条数超过限制"
        }):
            with self.assertRaises(cm_ncm.NcmError) as ctx:
                cm_ncm.phone_send_captcha("13800000000")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("当天发送验证码的条数超过限制", str(ctx.exception))

    def test_success_is_unchanged(self):
        with patch.object(cm_ncm, "call", return_value={"code": 200}):
            self.assertTrue(cm_ncm.phone_send_captcha("13800000000"))

    def test_transport_error_remains_gateway_error(self):
        with patch.object(cm_ncm, "call", side_effect=cm_ncm.NcmError("NCM 上游请求失败: timed out")):
            with self.assertRaises(cm_ncm.NcmError) as ctx:
                cm_ncm.phone_send_captcha("13800000000")
        self.assertIsNone(ctx.exception.status_code)


if __name__ == "__main__":
    unittest.main(verbosity=2)
