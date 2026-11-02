import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cm_ncm  # noqa: E402


class TestWallClockGuards(unittest.TestCase):
    def test_probe_hang_is_bounded_and_allowed(self):
        old = cm_ncm._probe_audio_once
        cm_ncm._probe_audio_once = lambda url, timeout: (time.sleep(1.0), (True, {}))[1]
        try:
            t0 = time.time()
            ok, spec = cm_ncm.probe_audio("https://example.invalid/x", timeout=0.2)
            elapsed = time.time() - t0
        finally:
            cm_ncm._probe_audio_once = old
        self.assertTrue(ok)                 # 超时按放行处理，不能拦播放
        self.assertEqual(spec, {})
        self.assertLess(elapsed, 0.9)       # 墙钟上限 = timeout + 0.3

    def test_upstream_call_hang_is_bounded(self):
        old = cm_ncm.call
        cm_ncm.call = lambda *a, **k: (time.sleep(1.0), {})[1]
        try:
            t0 = time.time()
            with self.assertRaises(cm_ncm.NcmError) as ctx:
                cm_ncm._bounded_call("/song/url/v1", {}, 0.2)
            elapsed = time.time() - t0
        finally:
            cm_ncm.call = old
        self.assertIn("超时", str(ctx.exception))
        self.assertLess(elapsed, 1.0)       # 墙钟上限 = timeout + 0.5

    def test_hung_thread_does_not_block_results(self):
        box = cm_ncm._run_with_wall_clock(
            lambda: (time.sleep(0.5), "late")[1], 0.1, default="timeout")
        self.assertEqual(box, "timeout")


if __name__ == "__main__":
    unittest.main()
