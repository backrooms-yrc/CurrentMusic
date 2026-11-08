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
import json
import sys
import tempfile
import time
import unittest
from unittest import mock

# cm_db 在 import 时读取 CM_DB，必须先设好环境变量再导入
_TMP = tempfile.mkdtemp(prefix="cm-listen-")
os.environ["CM_DB"] = os.path.join(_TMP, "cm.db")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_db  # noqa: E402
import cm_ncm  # noqa: E402
import cm_server  # noqa: E402
from backend.tests.test_password_reset import _Handler  # noqa: E402

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
    def test_finished_report_uses_its_own_full_playback(self):
        token = cm_db.issue_token(self.uid)
        cm_db.save_binding(self.uid, "test-binding", 42)

        def post(body):
            handler = _Handler("POST", "/plays/1", body, token=token)
            cm_server.route(handler, "POST")
            self.assertEqual(handler.status, 200)
            return json.loads(handler.wfile.getvalue())

        with mock.patch.object(cm_server, "_spawn_ncm_listen") as spawn:
            first = post({"name": "歌曲", "artists": "歌手", "duration": SONG_MS})["playId"]
            post({"playId": first, "totalMs": 65_000, "finished": False})
            second = post({"name": "歌曲", "duration": SONG_MS})["playId"]
            self.assertEqual(spawn.call_count, 2, "progress should not scrobble early")
            for total in (202_000, 60_000, 202_000):
                post({"playId": first, "totalMs": total, "finished": True})
            self.assertEqual(self.ms(), 202_000)
            self.assertEqual(spawn.call_count, 3)
            cookie, song, _, play = spawn.call_args.args
            self.assertEqual((cookie, song, play["rowid"], play["ms"]), ("test-binding", 1, first, 202_000))
            self.assertNotEqual(first, second)
            self.assertFalse(cm_db.update_play_total(self.uid + 1, 1, first, 999_000))

    def test_playback_clients_keep_separate_devices_for_the_same_song(self):
        token = cm_db.issue_token(self.uid)
        cm_db.save_binding(self.uid, "MUSIC_U=test-binding", 42)

        def post(body, ua):
            handler = _Handler("POST", "/plays/1", body, token=token)
            handler.headers["User-Agent"] = ua
            cm_server.route(handler, "POST")
            self.assertEqual(handler.status, 200)
            return json.loads(handler.wfile.getvalue())

        with (mock.patch.object(cm_server, "_spawn_ncm_listen") as spawn,
              mock.patch.object(cm_ncm, "web_scrobble_available", return_value=False)):
            native = post({"name": "歌曲", "duration": SONG_MS}, "okhttp/5.0")["playId"]
            web = post({"name": "歌曲", "duration": SONG_MS}, "Mozilla/5.0")["playId"]
            post({"ms": 65_000, "platform": "x"}, "okhttp/5.0")
            post({"playId": web, "totalMs": 120_000, "finished": True, "platform": "x"}, "okhttp/5.0")
            self.assertEqual([call.kwargs["playback_client"] for call in spawn.call_args_list],
                             ["x", "web", "x", "web"])
            self.assertEqual([call.args[3]["rowid"] for call in spawn.call_args_list[2:]], [native, web])
            self.assertEqual(self.ms(), 185_000)

    def _web_play_requests(self):
        token = cm_db.issue_token(self.uid)
        cm_db.save_binding(self.uid, "MUSIC_U=web-fixture", 42)

        def post(body):
            handler = _Handler("POST", "/plays/1", body, token=token)
            handler.headers["User-Agent"] = "Mozilla/5.0"
            cm_server.route(handler, "POST")
            self.assertEqual(handler.status, 200)
            return json.loads(handler.wfile.getvalue())

        return post

    def test_web_sends_deltas_during_playback_and_drains_a_concurrent_finish(self):
        post = self._web_play_requests()
        with (mock.patch.object(cm_server, "_spawn_ncm_listen") as start,
              mock.patch.object(cm_ncm, "web_scrobble_available", return_value=True),
              mock.patch.object(cm_ncm, "upload_web_play_log") as upload,
              mock.patch.object(cm_server._web_play_sync_pool, "submit",
                                side_effect=lambda fn, play_id: fn(play_id))):
            play_id = post({"name": "歌曲", "duration": SONG_MS})["playId"]

            def progress(seconds, finished=False):
                post({"playId": play_id, "totalMs": seconds * 1000, "finished": finished})

            def finish_while_uploading(cookie, song, kind, seconds, total):
                if kind == "pld" and upload.call_count == 3:
                    progress(73, True)

            progress(29)
            upload.assert_not_called()
            progress(30)
            self.assertEqual([call.args[2:4] for call in upload.call_args_list], [("plv", 30), ("pld", 30)])
            upload.side_effect = finish_while_uploading
            progress(60)
            progress(35)
            progress(73, True)
            self.assertEqual([call.args[2:4] for call in upload.call_args_list],
                             [("plv", 30), ("pld", 30), ("pld", 30), ("pld", 13)])
            self.assertEqual(self.ms(), 73_000)
            start.assert_called_once()
            self.assertTrue(all(call.args[0]["mode"] == "CurrentMusic Web" for call in upload.call_args_list))

    def test_web_retries_failed_duration_without_repeating_play_count(self):
        post = self._web_play_requests()
        with (mock.patch.object(cm_server, "_spawn_ncm_listen"),
              mock.patch.object(cm_ncm, "web_scrobble_available", return_value=True),
              mock.patch.object(cm_ncm, "upload_web_play_log",
                                side_effect=[None, cm_ncm.NcmError("rejected"), None]) as upload,
              mock.patch.object(cm_server._web_play_sync_pool, "submit",
                                side_effect=lambda fn, play_id: fn(play_id))):
            play_id = post({"name": "歌曲", "duration": SONG_MS})["playId"]
            for seconds in (30, 60, 60):
                post({"playId": play_id, "totalMs": seconds * 1000, "finished": False})
            self.assertEqual([call.args[2:4] for call in upload.call_args_list],
                             [("plv", 30), ("pld", 30), ("pld", 60)])

    def test_legacy_web_deltas_still_sync_with_ncbl_available(self):
        post = self._web_play_requests()
        with (mock.patch.object(cm_server, "_spawn_ncm_listen") as sync,
              mock.patch.object(cm_ncm, "web_scrobble_available", return_value=True)):
            post({"name": "歌曲", "duration": SONG_MS})
            post({"ms": 60_000})
            self.assertEqual(sync.call_count, 2)
            self.assertEqual(sync.call_args.args[3]["ms"], 60_000)

    def test_device_registration_failure_does_not_block_listening(self):
        with (mock.patch.object(cm_server.threading, "Thread") as thread,
              mock.patch.object(cm_ncm, "name_playback_device", side_effect=cm_ncm.NcmError("rejected")) as name,
              mock.patch.object(cm_ncm, "weblog") as weblog,
              mock.patch.object(cm_ncm, "scrobble") as scrobble):
            thread.side_effect = lambda *, target, **kwargs: mock.Mock(start=target)
            cm_server._spawn_ncm_listen("MUSIC_U=fixture", 1, None, playback_client="web")
            cm_server._spawn_ncm_listen("MUSIC_U=fixture", 1, None,
                                       {"ms": 120_000, "duration": SONG_MS, "name": "", "artists": ""},
                                       playback_client="web")
            name.assert_called_once()
            self.assertEqual(weblog.call_args.args[0], name.call_args.args[0])
            self.assertEqual(scrobble.call_args.args[0], name.call_args.args[0])
            self.assertEqual(scrobble.call_args.args[2], 120)

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


class TestScrobbleProtocol(unittest.TestCase):
    def test_playback_device_keeps_auth_and_supplies_ncbl_and_eapi_names(self):
        bound = "MUSIC_U=token+%2B; deviceId=imported; os=android; mode=Other; __csrf=csrf"
        web = cm_ncm.playback_device_cookie(bound, "web")
        android = cm_ncm.playback_device_cookie(bound, "x")
        self.assertEqual(web, cm_ncm.playback_device_cookie(bound, "web"))
        self.assertEqual(web["MUSIC_U"], "token+%2B")
        self.assertEqual(web["__csrf"], "csrf")
        self.assertNotEqual(web["deviceId"], android["deviceId"])
        self.assertNotEqual(web["deviceId"], "imported")
        self.assertEqual(web["os"], "pc")
        self.assertEqual((web["mode"], web["mobilename"]), ("CurrentMusic Web", "CurrentMusic Web"))
        self.assertEqual((android["mode"], android["mobilename"]), ("CurrentMusicX", "CurrentMusicX"))

        with mock.patch.object(cm_ncm, "post_json", return_value={"code": 200}) as post:
            cm_ncm.name_playback_device(web)
            post.assert_called_once_with("/deviceinfo/center/upload", {"deviceName": "CurrentMusic Web"},
                                         cookie=web, timeout=5.0, real_ip=None)

    def test_ncbl_requires_both_upload_receipts(self):
        details = {"plv": {"fileName": "p.ncbl"}, "pld": {"fileName": "d.ncbl"}}
        with mock.patch.object(cm_ncm, "post_json", return_value={"code": 200, "details": details}) as post:
            cm_ncm.scrobble("test-binding", 1, 125, total=180, name="歌曲", artist="歌手", real_ip="192.0.2.5")
            post.assert_called_once_with(
                "/scrobble/v1", {"id": 1, "time": 125, "total": 180, "name": "歌曲", "artist": "歌手"},
                cookie="test-binding", timeout=32.0, real_ip="192.0.2.5",
            )
            post.reset_mock()
            post.return_value = {"code": 200, "details": {"plv": details["plv"]}}
            with self.assertRaises(cm_ncm.NcmError):
                cm_ncm.scrobble("test-binding", 1, 125)
            self.assertEqual(post.call_count, 1)

    def test_legacy_fallback_checks_nested_play_result(self):
        missing = cm_ncm.NcmError("not found", status_code=404)
        with mock.patch.object(cm_ncm, "post_json", side_effect=[missing, {"code": 200, "details": {"play": {"code": 401}}}]) as post:
            with self.assertRaises(cm_ncm.NcmError):
                cm_ncm.scrobble("test-binding", 1, 125)
            self.assertEqual([call.args[0] for call in post.call_args_list], ["/scrobble/v1", "/scrobble"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
