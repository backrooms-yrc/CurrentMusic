import io
import os
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import cm_db
import cm_usage


class UsageTest(unittest.TestCase):
    def setUp(self):
        tmp = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(patch.object(cm_db, "DB_PATH", os.path.join(tmp, "usage.db")))
        self.enterContext(patch.object(cm_usage, "_pending", cm_usage._pending.copy()))
        self.enterContext(patch.object(cm_usage, "_next_cleanup", 0))
        cm_usage._pending.clear()
        cm_db.init()

    def epoch(self, date):
        return int(datetime.fromisoformat(date).replace(tzinfo=cm_usage.TZ).timestamp())

    def test_periods_at_year_boundary_and_flush(self):
        sunday = self.epoch("2023-12-31T23:59:59")
        monday = self.epoch("2024-01-01T00:01:00")
        with patch.object(cm_usage.time, "time", return_value=sunday):
            cm_usage.note_api("/playlist")
            cm_usage.note_api("/health")
            cm_usage.write_audio(SimpleNamespace(wfile=io.BytesIO()), b"audio")
        during_week = cm_usage.snapshot(sunday)["periods"]
        self.assertEqual(during_week["week"]["total"]["servedBytes"], 5)
        cm_usage.flush()
        with patch.object(cm_usage.time, "time", return_value=monday):
            cm_usage.note_api("/ncm/song/url")
            cm_usage.note_api("/usage/audio")
        periods = cm_usage.snapshot(monday)["periods"]
        for period in periods.values():
            self.assertEqual(period["total"], {"apiCalls": 1, "servedBytes": 0, "directEstimatedBytes": 0})
        self.assertEqual(periods["week"]["start"], monday - 60)
        self.assertEqual(periods["day"]["series"][0]["t"], monday - 60)
        cm_usage.flush()
        self.assertEqual(cm_usage.snapshot(monday)["periods"], periods)

    def test_calendar_week_can_start_in_previous_year(self):
        sunday = self.epoch("2023-12-31T15:00:00")
        tuesday = self.epoch("2024-01-02T00:00:00")
        cm_usage.report_audio({"session": "a" * 32, "bytes": 100}, sunday)
        periods = cm_usage.snapshot(tuesday)["periods"]
        self.assertEqual(periods["year"]["total"]["directEstimatedBytes"], 0)
        self.assertEqual(periods["week"]["total"]["directEstimatedBytes"], 0)

        new_year_sunday = self.epoch("2023-01-01T00:00:00")
        saturday = self.epoch("2022-12-31T23:00:00")
        cm_usage.report_audio({"session": "b" * 32, "bytes": 120}, saturday)
        periods = cm_usage.snapshot(new_year_sunday)["periods"]
        self.assertEqual(periods["year"]["total"]["directEstimatedBytes"], 0)
        self.assertEqual(periods["week"]["total"]["directEstimatedBytes"], 120)

    def test_concurrent_cumulative_reports_and_boundary(self):
        end = self.epoch("2026-11-19T23:59:59")
        start = end + 1
        with ThreadPoolExecutor(max_workers=4) as executor:
            list(executor.map(lambda size: cm_usage.report_audio({"session": "1" * 32, "bytes": size}, end),
                              [100, 40, 100, 200, 80]))
        cm_usage.report_audio({"session": "1" * 32, "bytes": 250}, start)
        self.assertEqual(cm_usage.snapshot(end)["periods"]["day"]["total"]["directEstimatedBytes"], 200)
        self.assertEqual(cm_usage.snapshot(start)["periods"]["day"]["total"]["directEstimatedBytes"], 50)
        self.assertEqual(cm_usage.snapshot(start)["periods"]["month"]["total"]["directEstimatedBytes"], 250)

    def test_invalid_reports_and_failed_audio_write(self):
        for body in (None, {"session": "bad", "bytes": 1}, {"session": "a" * 32, "bytes": True},
                     {"session": "a" * 32, "bytes": cm_usage.MAX_AUDIO_BYTES + 1}):
            with self.assertRaises(ValueError):
                cm_usage.report_audio(body)
        stream = io.BytesIO()
        stream.close()
        with self.assertRaises(ValueError):
            cm_usage.write_audio(SimpleNamespace(wfile=stream), b"audio")
        self.assertEqual(cm_usage.snapshot()["periods"]["day"]["total"]["servedBytes"], 0)
