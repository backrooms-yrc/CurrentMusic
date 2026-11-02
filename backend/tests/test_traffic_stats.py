import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import cm_traffic  # noqa: E402


def _line(ts_fmt, uri, status=200, nbytes=1000):
    # ts_fmt: "21/Oct/2026:10:00:00 +0800"
    return (f'1.2.3.4 - - [{ts_fmt}] "GET {uri} HTTP/1.1" {status} {nbytes} '
            f'"-" "Mozilla/5.0"\n')


class TestTrafficStats(unittest.TestCase):
    def _log(self, lines):
        fd, path = tempfile.mkstemp(suffix=".log", prefix="cm-traffic-")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.writelines(lines)
        self.addCleanup(os.unlink, path)
        return path

    @staticmethod
    def _today(hour_min_sec, day_offset=0):
        # 日期必须动态生成：写死日期的测试一过午夜就失效
        ts = time.time() + day_offset * 86400
        return (time.strftime("%d/%b/%Y:", time.localtime(ts)) + hour_min_sec
                + time.strftime(" %z", time.localtime(ts)))

    def test_unavailable_without_log(self):
        out = cm_traffic.snapshot("")
        self.assertFalse(out["available"])
        out = cm_traffic.snapshot("/nonexistent/xx.log")
        self.assertFalse(out["available"])

    def test_aggregation_buckets_and_top(self):
        path = self._log([
            _line(self._today("10:05:00"), "/cm/avatar/33.jpg", nbytes=500),
            _line(self._today("10:06:00"), "/cm/avatar/5-abc.jpg", nbytes=300),
            _line(self._today("11:00:00"), "/cm/x/download/latest", nbytes=2000),
            _line(self._today("11:00:01"), "/cm/x/download/latest?x=1", nbytes=2000),
            _line(self._today("11:00:02"), "/app/app.js", nbytes=100),
            _line(self._today("11:00:03"), "/cm/avatar/33.jpg", status=404, nbytes=999),
            _line(self._today("23:00:00", day_offset=-1), "/app/app.css", nbytes=700),
        ])
        out = cm_traffic.snapshot(path)
        self.assertTrue(out["available"])
        self.assertEqual(out["today"], 500 + 300 + 2000 + 2000 + 100)   # 404 不计
        # 时桶：10 点 800、11 点 4100、昨天 23 点 700
        hmap = {h["t"]: h["bytes"] for h in out["hourly"]}
        self.assertIn(800, hmap.values())
        self.assertIn(4100, hmap.values())
        # Top 家族折叠：avatar/* 800、x/download 原样保留（不在折叠名单）
        top = {t["path"]: t for t in out["top"]}
        self.assertIn("/cm/avatar/*", top)
        self.assertEqual(top["/cm/avatar/*"]["bytes"], 800)
        self.assertEqual(top["/cm/avatar/*"]["req"], 2)
        self.assertEqual(top["/cm/x/download/latest"]["bytes"], 4000)
        self.assertEqual(top["/cm/x/download/latest"]["req"], 2)

    def test_cache_reuses_result(self):
        path = self._log([_line(self._today("10:00:00"), "/a", nbytes=10)])
        a = cm_traffic.snapshot(path)
        b = cm_traffic.snapshot(path)
        self.assertIs(a, b)   # 20s 内且日志未变：命中缓存同一对象

    def test_rate_uses_last_5min(self):
        now = int(time.time())
        lt = time.strftime("%d/%b/%Y:%H:%M:%S %z", time.localtime(now))
        old = time.strftime("%d/%b/%Y:%H:%M:%S %z", time.localtime(now - 3600))
        path = self._log([
            _line(lt, "/a", nbytes=3000),
            _line(old, "/a", nbytes=9999),
        ])
        out = cm_traffic.snapshot(path)
        # 3000B/300s = 10B/s；一小时前的 9999B 不计入速率
        self.assertAlmostEqual(out["rate5m"], 10.0, delta=2.0)


if __name__ == "__main__":
    unittest.main()
