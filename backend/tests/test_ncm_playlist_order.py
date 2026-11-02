#!/usr/bin/env python3
"""网易云同步歌单排序回归测试。

需求：CurrentMusic「歌单 → 网易云同步」的列表顺序必须与网易云 App
「我的 → 音乐」一致，即 /user/playlist 的返回顺序（我喜欢的音乐 → 自建 → 收藏）。
旧实现按导入完成时间排序，4 并发导入会把这个顺序打乱。

    python3 -m unittest backend.tests.test_ncm_playlist_order -v
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_db  # noqa: E402
import cm_server  # noqa: E402


class TestNcmPlaylistOrder(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = cm_db.DB_PATH
        cm_db.DB_PATH = os.path.join(self.tmp.name, "test.db")
        cm_db.init()
        self.uid = cm_db.create_user("playlist_order_test", "password123", "排序测试")

    def tearDown(self):
        cm_db.DB_PATH = self.old_db
        self.tmp.cleanup()

    def test_playlists_of_matches_ncm_order(self):
        local1 = cm_db.create_playlist(self.uid, "本地旧")
        local2 = cm_db.create_playlist(self.uid, "本地新")
        ncm_late = cm_db.create_playlist(self.uid, "上游第 2", source="ncm",
                                         ncm_pl_id=2002, ncm_order=1)
        ncm_first = cm_db.create_playlist(self.uid, "上游第 1", source="ncm",
                                          ncm_pl_id=2001, ncm_order=0)

        out = cm_db.playlists_of(self.uid)
        self.assertEqual([p["id"] for p in out[:2]], [ncm_first, ncm_late])
        self.assertEqual([p["id"] for p in out[2:]], [local2, local1])  # 本地仍按创建倒序
        self.assertEqual([p["ncmOrder"] for p in out[:2]], [0, 1])

    def test_bulk_order_demotes_stale_snapshots(self):
        cur1 = cm_db.create_playlist(self.uid, "当前 1", source="ncm", ncm_pl_id=101, ncm_order=99)
        cur2 = cm_db.create_playlist(self.uid, "当前 2", source="ncm", ncm_pl_id=102, ncm_order=99)
        stale = cm_db.create_playlist(self.uid, "上游已删除", source="ncm", ncm_pl_id=999, ncm_order=0)
        cm_db.set_ncm_playlist_orders(self.uid, [102, 101])

        out = cm_db.playlists_of(self.uid)
        self.assertEqual([p["id"] for p in out], [cur2, cur1, stale])
        self.assertEqual(out[-1]["ncmOrder"], 2)

    def test_sync_preserves_upstream_order_despite_concurrency(self):
        cm_db.save_binding(self.uid, "cookie", 4242, "NCM 用户")
        # 预置两个顺序错误的旧快照；同步后必须按上游顺序重排
        old_b = cm_db.create_playlist(self.uid, "旧 B", source="ncm", ncm_pl_id=22, ncm_order=99)
        old_a = cm_db.create_playlist(self.uid, "旧 A", source="ncm", ncm_pl_id=21, ncm_order=99)

        upstream = [
            {"ncm_pl_id": 21, "name": "上游 A", "cover": "a.jpg", "track_count": 1, "order": 0},
            {"ncm_pl_id": 22, "name": "上游 B", "cover": "b.jpg", "track_count": 2, "order": 1},
        ]
        with mock.patch.object(cm_server.cm_ncm, "user_account", return_value={"uid": 4242, "code": 200, "nickname": "NCM 用户", "avatar": ""}), \
             mock.patch.object(cm_server.cm_ncm, "user_playlists", return_value=upstream), \
             mock.patch.object(cm_server.cm_ncm, "playlist_full",
                               side_effect=lambda cookie, pid: {"name": f"上游 {pid}", "cover": f"{pid}.jpg", "songs": []}):
            r = cm_server.sync_ncm_playlists(self.uid, budget=10)

        self.assertEqual(r["imported"], 2)
        self.assertEqual([p["ncmOrder"] for p in r["playlists"]], [0, 1])
        out = cm_db.playlists_of(self.uid)
        self.assertEqual([p["id"] for p in out], [old_a, old_b])
        self.assertEqual([p["ncmOrder"] for p in out], [0, 1])


if __name__ == "__main__":
    unittest.main(verbosity=2)
