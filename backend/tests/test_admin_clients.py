#!/usr/bin/env python3
"""管理台「客户端」页数据接口测试（CurrentMusic + CurrentMusicX）。

不依赖真实 releases 目录：临时造两份 latest.json，并把两个目录常量指过去。
覆盖：管理员可读、返回字段、镜像状态按磁盘实时判断、非管理员 403。

    python3 -m unittest backend.tests.test_admin_clients -v
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
import cm_server  # noqa: E402


class _Handler:
    def __init__(self, method, path, token="", ip="10.0.0.1"):
        self.command = method
        self.path = path
        self.rfile = io.BytesIO(b"")
        self.wfile = io.BytesIO()
        self.client_address = ("127.0.0.1", 0)
        self.status = 0
        self.headers = {"Content-Length": "0", "X-Real-IP": ip}
        if token:
            self.headers["Authorization"] = "Bearer " + token

    def send_response(self, code):
        self.status = code

    def send_header(self, key, value):
        pass

    def end_headers(self):
        pass


class TestAdminClients(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = cm_db.DB_PATH
        cm_db.DB_PATH = os.path.join(self.tmp.name, "test.db")
        cm_db.init()
        cm_server._auth_buckets.clear()
        cm_server._rl_buckets.clear()

        self.rel = os.path.join(self.tmp.name, "releases")
        self.xrel = os.path.join(self.tmp.name, "releases-x")
        os.makedirs(self.rel)
        os.makedirs(self.xrel)
        with open(os.path.join(self.rel, "CurrentMusic-v9.9.9.apk"), "wb") as f:
            f.write(b"PK\x03\x04")
        with open(os.path.join(self.xrel, "CurrentMusic-Android-v1.2.5.apk"), "wb") as f:
            f.write(b"PK\x03\x04")
        with open(os.path.join(self.rel, "latest.json"), "w", encoding="utf-8") as f:
            json.dump({
                "version": "9.9.9", "versionCode": 99, "fileName": "CurrentMusic-v9.9.9.apk",
                "size": 4, "changelog": "本站更新说明", "publishedAt": 1700000000,
            }, f)
        with open(os.path.join(self.xrel, "latest.json"), "w", encoding="utf-8") as f:
            json.dump({
                "repo": "bileizhen/CurrentMusicX",
                "repoUrl": "https://github.com/bileizhen/CurrentMusicX",
                "releasesUrl": "https://github.com/bileizhen/CurrentMusicX/releases",
                "tag": "v1.2.5", "version": "1.2.5", "name": "CurrentMusicX v1.2.5",
                "body": "## 更新内容\n\n- 测试", "publishedAt": 1793266364,
                "htmlUrl": "https://github.com/bileizhen/CurrentMusicX/releases/tag/v1.2.5",
                "apk": {
                    "fileName": "CurrentMusic-Android-v1.2.5.apk", "size": 4,
                    "versionCode": 32, "minSdk": 26, "targetSdk": 36,
                    "downloads": 253, "sha256": "abc",
                },
                "history": [
                    {"tag": "v1.2.5", "version": "1.2.5", "publishedAt": "2026-10-29T09:32:44Z",
                     "apkName": "CurrentMusic-Android-v1.2.5.apk", "apkSize": 4,
                     "apkDownloads": 253, "htmlUrl": "https://example.com"},
                ],
                "syncedAt": 1793266400,
            }, f)
        self.addCleanup(self._cleanup)
        self._patches = [
            mock.patch.object(cm_server, "RELEASES_DIR", self.rel),
            mock.patch.object(cm_server, "X_RELEASES_DIR", self.xrel),
        ]
        for p in self._patches:
            p.start()
            self.addCleanup(p.stop)

    def _cleanup(self):
        cm_db.DB_PATH = self.old_db
        self.tmp.cleanup()

    def _call(self, path, token=""):
        h = _Handler("GET", path, token=token)
        try:
            cm_server.route(h, "GET")
        except cm_server.ApiError as e:
            return e.code, {"error": e.msg}
        return h.status, json.loads(h.wfile.getvalue().decode("utf-8") or "{}")

    def test_admin_payload(self):
        uid = cm_db.create_user("client_admin", "password123", "客户端管理员")
        cm_db.set_admin(uid, True)
        token = cm_db.issue_token(uid, "test")
        status, d = self._call("/admin/clients", token)
        self.assertEqual(status, 200, d)
        self.assertEqual(d["current"]["version"], "9.9.9")
        self.assertTrue(d["current"]["mirrored"])
        self.assertEqual(d["current"]["downloadPath"], "/download/latest")
        self.assertEqual(d["cmx"]["version"], "1.2.5")
        self.assertEqual(d["cmx"]["apk"]["versionCode"], 32)
        self.assertEqual(d["cmx"]["apk"]["minSdk"], 26)
        self.assertTrue(d["cmx"]["apk"]["mirrored"])
        self.assertEqual(len(d["cmx"]["history"]), 1)
        self.assertEqual(d["cmx"]["history"][0]["apkDownloads"], 253)
        self.assertEqual(d["cmx"]["downloadPath"], "/x/download/latest")

    def test_admin_traffic_route(self):
        # 回归：/admin/clients 插入时曾误删 /admin/traffic 的路由头，
        # 管理台因此显示「未知接口 GET /admin/traffic」。
        uid = cm_db.create_user("traffic_admin", "password123", "流量管理员")
        cm_db.set_admin(uid, True)
        token = cm_db.issue_token(uid, "test")
        status, d = self._call("/admin/traffic", token)
        self.assertEqual(status, 200, d)
        self.assertIn("available", d)

    def test_non_admin_forbidden(self):
        uid = cm_db.create_user("client_user", "password123", "普通用户")
        token = cm_db.issue_token(uid, "test")
        status, d = self._call("/admin/clients", token)
        self.assertEqual(status, 403, d)


if __name__ == "__main__":
    unittest.main(verbosity=2)
