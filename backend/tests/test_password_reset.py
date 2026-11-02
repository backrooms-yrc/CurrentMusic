#!/usr/bin/env python3
"""密码找回/修改（邮箱验证码）回归测试。

覆盖四条最容易回归的链路：
  1. 未登录找回：发码 → 错码计数 → 正确码重置 → 旧密码失效、全部会话下线；
  2. 已登录修改：验证码发到绑定邮箱 → 保留当前设备、下线其他设备；
  3. 命名空间隔离：登录码不能拿来重置密码；
  4. 未绑定邮箱 / 新密码长度等边界。

    python3 -m unittest backend.tests.test_password_reset -v
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_db  # noqa: E402
import cm_mail  # noqa: E402
import cm_server  # noqa: E402


class _Handler:
    """最小 HTTP handler 桩：够 route()/read_json()/jresp() 用。"""

    def __init__(self, method, path, body=None, token="", ip="10.0.0.1"):
        raw = b"" if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.command = method
        self.path = path
        self.rfile = io.BytesIO(raw)
        self.wfile = io.BytesIO()
        self.client_address = ("127.0.0.1", 0)
        self.status = 0
        self.headers = {
            "Content-Length": str(len(raw)),
            "Content-Type": "application/json",
            "X-Real-IP": ip,
        }
        if token:
            self.headers["Authorization"] = "Bearer " + token

    def send_response(self, code):
        self.status = code

    def send_header(self, key, value):
        pass

    def end_headers(self):
        pass


class TestPasswordReset(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = cm_db.DB_PATH
        cm_db.DB_PATH = os.path.join(self.tmp.name, "test.db")
        cm_db.init()
        # 进程内限速桶逐用例清空，避免用例之间互相挤占
        cm_server._auth_buckets.clear()
        cm_server._rl_buckets.clear()
        cm_server._email_ip_hour.clear()

        self.sent = []

        def fake_send(to_email, code, ttl_min=5, purpose="注册"):
            self.sent.append({"to": to_email, "code": code, "purpose": purpose})

        self._patches = [
            mock.patch.object(cm_mail, "smtp_ready", return_value=True),
            mock.patch.object(cm_mail, "send_code_email", side_effect=fake_send),
        ]
        for p in self._patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        cm_db.DB_PATH = self.old_db
        self.tmp.cleanup()

    def call(self, method, path, body=None, token="", ip="10.0.0.1"):
        h = _Handler(method, path, body=body, token=token, ip=ip)
        try:
            cm_server.route(h, method)
        except cm_server.ApiError as e:      # 正常由 Handler._dispatch 转成 JSON
            return e.code, {"error": e.msg}
        raw = h.wfile.getvalue().decode("utf-8") or "{}"
        try:
            data = json.loads(raw)
        except ValueError:
            data = {"_raw": raw}
        return h.status, data

    def make_user(self, email="alice@example.com", password="oldpass"):
        uid = cm_db.create_user("alice", password, "Alice", email)
        return uid

    def send_reset_code(self, email="alice@example.com", ip="10.0.0.1"):
        status, data = self.call("POST", "/auth/password/code", {"email": email}, ip=ip)
        self.assertEqual(status, 200, data)
        self.assertEqual(self.sent[-1]["to"], email)
        self.assertEqual(self.sent[-1]["purpose"], "重置密码")
        self.assertRegex(self.sent[-1]["code"], r"^\d{6}$")
        return self.sent[-1]["code"]

    # ---------- 未登录找回 ----------

    def test_reset_revokes_sessions_and_changes_password(self):
        uid = self.make_user()
        t1 = cm_db.issue_token(uid, "设备一")
        t2 = cm_db.issue_token(uid, "设备二")
        self.assertIsNotNone(cm_db.user_by_token(t1))

        code = self.send_reset_code()
        self.assertEqual(cm_db.get_email_code("reset:alice@example.com")["code"], code)

        # 错码只累计 tries，不消耗正确码
        wrong = "000000" if code != "000000" else "111111"
        status, _ = self.call("POST", "/auth/password/reset",
                              {"email": "alice@example.com", "code": wrong, "newPassword": "newpass1"})
        self.assertEqual(status, 400)
        self.assertEqual(cm_db.get_email_code("reset:alice@example.com")["tries"], 1)

        status, data = self.call("POST", "/auth/password/reset",
                                 {"email": "alice@example.com", "code": code, "newPassword": "newpass1"})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["username"], "alice")

        self.assertIsNone(cm_db.verify_login("alice", "oldpass"))
        self.assertIsNotNone(cm_db.verify_login("alice", "newpass1"))
        self.assertIsNone(cm_db.user_by_token(t1))
        self.assertIsNone(cm_db.user_by_token(t2))
        self.assertIsNone(cm_db.get_email_code("reset:alice@example.com"))

    def test_login_code_namespace_cannot_reset(self):
        self.make_user()
        # 登录码存在 login:<email>，直接拿它来重置必须失败
        cm_db.save_email_code("login:alice@example.com", "654321", 300)
        status, data = self.call("POST", "/auth/password/reset",
                                 {"email": "alice@example.com", "code": "654321", "newPassword": "newpass1"})
        self.assertEqual(status, 400, data)
        self.assertIsNotNone(cm_db.verify_login("alice", "oldpass"))

    def test_unknown_email_and_short_password(self):
        status, _ = self.call("POST", "/auth/password/code", {"email": "nobody@example.com"})
        self.assertEqual(status, 404)
        self.assertEqual(self.sent, [])

        self.make_user()
        status, _ = self.call("POST", "/auth/password/reset",
                              {"email": "alice@example.com", "code": "123456", "newPassword": "123"})
        self.assertEqual(status, 400)

    def test_send_cooldown(self):
        self.make_user()
        self.send_reset_code()
        status, data = self.call("POST", "/auth/password/code",
                                 {"email": "alice@example.com"}, ip="10.0.0.2")
        self.assertEqual(status, 429, data)      # 冷却按邮箱（DB），不因换 IP 绕过
        self.assertEqual(len(self.sent), 1)

    # ---------- 已登录修改 ----------

    def test_logged_in_email_code_keeps_current_session(self):
        uid = self.make_user()
        current = cm_db.issue_token(uid, "当前设备")
        other = cm_db.issue_token(uid, "其他设备")

        status, data = self.call("POST", "/profile/password/code", {}, token=current)
        self.assertEqual(status, 200, data)
        self.assertEqual(data["email"], "a***@example.com")
        code = self.sent[-1]["code"]
        self.assertEqual(self.sent[-1]["purpose"], "修改密码")

        status, data = self.call("PUT", "/profile/password",
                                 {"emailCode": code, "newPassword": "newpass2"}, token=current)
        self.assertEqual(status, 200, data)
        self.assertEqual(data["revoked"], 1)
        self.assertIsNotNone(cm_db.user_by_token(current))   # 当前设备保留
        self.assertIsNone(cm_db.user_by_token(other))        # 其他设备下线
        self.assertIsNotNone(cm_db.verify_login("alice", "newpass2"))

    def test_profile_password_requires_a_credential(self):
        uid = self.make_user()
        token = cm_db.issue_token(uid, "设备")
        status, _ = self.call("PUT", "/profile/password", {"newPassword": "newpass2"}, token=token)
        self.assertEqual(status, 400)

    def test_old_password_change_still_works(self):
        uid = self.make_user()
        token = cm_db.issue_token(uid, "设备")
        status, data = self.call("PUT", "/profile/password",
                                 {"oldPassword": "oldpass", "newPassword": "newpass3"}, token=token)
        self.assertEqual(status, 200, data)
        self.assertIsNotNone(cm_db.verify_login("alice", "newpass3"))
        self.assertIsNotNone(cm_db.user_by_token(token))      # 原密码方式不下线当前设备

    def test_profile_code_requires_bound_email(self):
        uid = cm_db.create_user("bob", "oldpass", "Bob", "")
        token = cm_db.issue_token(uid, "设备")
        status, data = self.call("POST", "/profile/password/code", {}, token=token)
        self.assertEqual(status, 400, data)
        self.assertIn("未绑定邮箱", data["error"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
