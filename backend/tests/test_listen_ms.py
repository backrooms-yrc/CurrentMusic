#!/usr/bin/env python3
"""听歌时长口径测试。

**问题（2026-10-01 用户指出）**：旧口径是
    SUM(songs.duration) over plays
它只反映「点开过多少首**不同的**歌」，与真实收听无关，两头都错：

  · 点开一首 5 分钟的歌、3 秒后切走 → 记满 5 分钟（**虚高**）
  · 同一首听 100 遍 → 只记 1 遍（record_play 会把同曲旧记录删掉，**虚低**）
  · 广场「听歌时长」排序、挂件解锁门槛（2 小时）都用它 → 点一遍所有歌即可"刷"出来

**现在**：只累计 `plays.ms`（前端按真实播放推进上报，暂停/拖动/后台挂起都不计），
历史数据一次性重建为 `min(下次播放间隔, 曲目时长)`。
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
import unittest

# cm_db 在 import 时读取 CM_DB，必须先设好环境变量再导入
_TMP = tempfile.mkdtemp(prefix="cm-listen-")
os.environ["CM_DB"] = os.path.join(_TMP, "cm.db")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_db  # noqa: E402

SONG_MS = 300_000          # 5 分钟的歌


def _require_test_db():
    """Never let this destructive fixture run against the production database."""
    path = os.path.realpath(cm_db.DB_PATH)
    if "cm-listen-" not in path and "cm-tests-" not in path:
        raise unittest.SkipTest(f"refusing to delete users in non-test DB: {path}")


class ListenMsBase(unittest.TestCase):
    def setUp(self):
        _require_test_db()
        cm_db.init()
        conn = cm_db.connect()
        try:
            conn.executescript("DELETE FROM plays; DELETE FROM songs; DELETE FROM users;")
            conn.execute(
                "INSERT INTO users(username,pass_hash,salt,nickname,created_at)"
                " VALUES('t','h','s','测试',?)", (int(time.time()),))
            self.uid = conn.execute("SELECT id FROM users").fetchone()["id"]
            conn.execute(
                "INSERT INTO songs(ncm_id,name,duration,created_at) VALUES(1,'五分钟的歌',?,?)",
                (SONG_MS, int(time.time())))
            conn.commit()
        finally:
            conn.close()

    def ms(self):
        return cm_db.listen_ms(self.uid)

    def test_ncm_sync_candidate_claimed_once_and_retryable(self):
        cm_db.record_play(self.uid, 1)
        self.assertIsNone(cm_db.play_sync_candidate(self.uid, 1))
        cm_db.add_play_ms(self.uid, 1, 30_000)
        self.assertIsNone(cm_db.play_sync_candidate(self.uid, 1))
        cm_db.add_play_ms(self.uid, 1, 30_000)
        claimed = cm_db.play_sync_candidate(self.uid, 1)
        self.assertIsNotNone(claimed)
        self.assertGreaterEqual(claimed["ms"], 60_000)
        self.assertIsNone(cm_db.play_sync_candidate(self.uid, 1), "same playback must not sync twice")
        cm_db.reset_play_sync(claimed["rowid"])
        self.assertIsNotNone(cm_db.play_sync_candidate(self.uid, 1), "failed upload must be retryable")


class TestRealListening(ListenMsBase):
    def test_skip_counts_only_real_time(self):
        """点开就切走：只记真实听的那点时间，绝不按整首计。"""
        cm_db.record_play(self.uid, 1)
        self.assertEqual(self.ms(), 0, "刚点开还没上报，不该凭空有 5 分钟")
        cm_db.add_play_ms(self.uid, 1, 20_000)          # 真听了 20 秒
        self.assertEqual(self.ms(), 20_000)
        self.assertLess(self.ms(), SONG_MS, "旧口径此时会记满 300000")

    def test_replay_accumulates(self):
        """同一首听两遍要累加（旧实现把同曲旧记录删掉，只留一遍）。"""
        cm_db.record_play(self.uid, 1)
        cm_db.add_play_ms(self.uid, 1, 20_000)
        cm_db.record_play(self.uid, 1)                  # 重播：新开一条记录
        cm_db.add_play_ms(self.uid, 1, 30_000)
        self.assertEqual(self.ms(), 50_000)
        conn = cm_db.connect()
        try:
            rows = conn.execute("SELECT COUNT(*) c FROM plays WHERE user_id=?", (self.uid,)).fetchone()["c"]
        finally:
            conn.close()
        self.assertEqual(rows, 2, "重播应各留一条记录，否则累计会丢失")

    def test_multiple_increments_sum(self):
        """每 30s 一次的增量上报要能连加。"""
        cm_db.record_play(self.uid, 1)
        for _ in range(4):
            cm_db.add_play_ms(self.uid, 1, 30_000)
        self.assertEqual(self.ms(), 120_000)

    def test_cap_per_call(self):
        """单次上报有上限，异常巨值不会一次性灌进来。"""
        cm_db.record_play(self.uid, 1)
        added = cm_db.add_play_ms(self.uid, 1, 10_000_000)
        self.assertEqual(added, cm_db.PLAY_MS_MAX_PER_CALL)
        self.assertEqual(self.ms(), cm_db.PLAY_MS_MAX_PER_CALL)

    def test_invalid_values_ignored(self):
        cm_db.record_play(self.uid, 1)
        for bad in (0, -5, None, "abc"):
            self.assertEqual(cm_db.add_play_ms(self.uid, 1, bad), 0)
        self.assertEqual(self.ms(), 0)

    def test_no_row_to_attribute(self):
        """没先 record_play 时，增量没有可归属的记录 → 不记、不报错。"""
        self.assertEqual(cm_db.add_play_ms(self.uid, 1, 5_000), 0)
        self.assertEqual(self.ms(), 0)

    def test_decor_threshold_uses_same_number(self):
        """挂件门槛必须跟展示口径一致：跳歌刷不出解锁。"""
        cm_db.record_play(self.uid, 1)
        cm_db.add_play_ms(self.uid, 1, 60_000)          # 只听了 1 分钟
        self.assertFalse(cm_db.decor_unlocked(self.uid))
        # 按合法增量累到门槛（单次有 15 分钟上限，见 PLAY_MS_MAX_PER_CALL）
        need, step = cm_db.DECOR_MIN_MS, cm_db.PLAY_MS_MAX_PER_CALL
        while need > 0:
            cm_db.add_play_ms(self.uid, 1, min(step, need))
            need -= step
        self.assertTrue(cm_db.decor_unlocked(self.uid))


class TestLegacyBackfill(ListenMsBase):
    def _make_legacy(self):
        """造一张**没有 ms 列**的旧表，并塞入两条相隔 30 秒的播放记录。"""
        conn = cm_db.connect()
        try:
            conn.executescript("""
                DROP TABLE plays;
                CREATE TABLE plays (user_id INTEGER NOT NULL, ncm_id INTEGER NOT NULL, played_at INTEGER NOT NULL);
            """)
            base = int(time.time()) - 3600
            conn.executemany("INSERT INTO plays(user_id,ncm_id,played_at) VALUES(?,?,?)",
                             [(self.uid, 1, base), (self.uid, 1, base + 30)])
            conn.commit()
        finally:
            conn.close()

    def test_backfill_uses_gap_capped_by_duration(self):
        self._make_legacy()
        cm_db.init()                                    # 触发补列 + 历史重建
        conn = cm_db.connect()
        try:
            rows = conn.execute("SELECT ms FROM plays ORDER BY played_at").fetchall()
        finally:
            conn.close()
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["ms"], 30_000, "第一条：与下一条相隔 30s → 记 30s（而不是整首 5 分钟）")
        self.assertEqual(rows[1]["ms"], SONG_MS, "最后一条：按 min(now-播放时刻, 曲目时长) 上限截断")

    def test_backfill_is_idempotent(self):
        self._make_legacy()
        cm_db.init()
        first = self.ms()
        cm_db.init()                                    # 再跑一次不应重复处理
        self.assertEqual(self.ms(), first)


if __name__ == "__main__":
    unittest.main(verbosity=2)
