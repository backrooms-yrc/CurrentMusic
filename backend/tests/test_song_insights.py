"""Song insight contracts and trusted RealIP/cache boundaries; temporary DB only."""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cm_ncm
import cm_songinfo
import test_password_reset as harness


class SongInsightsTests(unittest.TestCase):
    setUp = harness.TestPasswordReset.setUp
    _cleanup = harness.TestPasswordReset._cleanup
    call = harness.TestPasswordReset.call

    def test_quality_levels_include_new_formats_without_claiming_playability(self):
        data = {key: {"br": 800000, "sr": 48000, "size": 1000000, "fid": "private"}
                for key, _, _ in cm_songinfo.QUALITY_LEVELS}
        data["sks"] = [{"it": "c512", "br": 1234}, {"it": "ste2", "sr": "44100"},
                       {"it": "unknown"}, None]
        with mock.patch.object(cm_ncm, "call", return_value={"code": 200, "data": data}) as upstream:
            out = cm_songinfo.qualities(1, "198.51.100.21")
        self.assertEqual(out["playability"], "unknown")
        rows = {v["level"]: v for v in out["qualities"]}
        self.assertEqual(len(rows), 10)
        self.assertEqual(rows["jyeffect"]["label"], "高清臻音")
        self.assertEqual(rows["vivid"]["label"], "臻音全景声")
        self.assertEqual([v["immerseType"] for v in rows["sky"]["variants"]], ["c512", "ste2"])
        self.assertEqual(rows["sky"]["variants"][1]["sr"], 44100)
        self.assertNotIn("fid", str(out))
        self.assertEqual(upstream.call_args.kwargs["real_ip"], "198.51.100.21")

    def test_empty_quality_and_invalid_numeric_values(self):
        with mock.patch.object(cm_ncm, "call", return_value={"data": {"l": {}, "h": None,
                               "sk": {"br": float("nan"), "size": -4}, "vi": {"sr": float("inf")}}}):
            self.assertEqual(cm_songinfo.qualities(1, "")["qualities"], [])

    def test_chorus_sorts_deduplicates_and_discards_wrong_song_or_invalid_ranges(self):
        raw = [{"id": 1, "startTime": 10000, "endTime": 20000},
               {"id": 1, "startTime": 0, "endTime": 1000},
               {"id": 1, "startTime": 10000, "endTime": 20000},
               {"id": 2, "startTime": 1, "endTime": 2},
               {"startTime": -1, "endTime": 2000}, {"startTime": 5, "endTime": 4},
               {"endTime": 2000}, {"startTime": "bad", "endTime": 2000},
               {"startTime": float("nan"), "endTime": 2000}, None]
        with mock.patch.object(cm_ncm, "call", return_value={"code": 200, "chorus": raw}):
            self.assertEqual(cm_songinfo.chorus(1, "")["segments"],
                             [{"startMs": 0, "endMs": 1000}, {"startMs": 10000, "endMs": 20000}])
        with mock.patch.object(cm_ncm, "call", return_value={"data": []}):
            self.assertEqual(cm_songinfo.chorus(1, "")["segments"], [])

    def test_versions_reads_rcmd_and_never_repeats_original(self):
        song = {"id": 2, "name": "另一版本", "ar": [{"id": 3, "name": "歌手"}],
                "al": {"name": "专辑", "picUrl": "http://example.test/cover.jpg"}, "dt": 234000}
        with mock.patch.object(cm_ncm, "call", return_value={"code": 200, "data": {
                "originSong": {"id": 1, "name": "原曲"}, "rcmd": song, "sp": {"pl": 320000}}}):
            out = cm_songinfo.versions(1, "")
        self.assertEqual(out["songs"][0]["ncm_id"], 2)
        self.assertEqual(out["songs"][0]["artists"], "歌手")
        self.assertEqual(out["songs"][0]["pic"], "https://example.test/cover.jpg")
        self.assertEqual(out["playability"], "unknown")
        for data in ({"originSong": song}, {"rcmd": {"id": 1}}, {"rcmd": [song, song, None]}):
            with mock.patch.object(cm_ncm, "call", return_value={"data": data}):
                ids = [s["ncm_id"] for s in cm_songinfo.versions(1, "")["songs"]]
                self.assertEqual(ids, [2] if isinstance(data.get("rcmd"), list) else [])

    def test_routes_are_public_validate_ids_and_ignore_forged_realip(self):
        for path, data, field in [("/song/qualities", {}, "qualities"),
                                  ("/song/chorus", [], "segments"),
                                  ("/song/versions", {}, "songs")]:
            with mock.patch.object(cm_ncm, "call", return_value={"code": 200, "data": data}) as upstream:
                for invalid in ("", "0", "-1", "abc", "1.5", str(2**63)):
                    self.assertEqual(self.call("GET", path + "?id=" + invalid)[0], 400)
                for ip in ("198.51.100.21", "198.51.100.21", "198.51.100.22"):
                    status, out = self.call("GET", path + "?id=1&realIP=203.0.113.99&cookie=forged", ip=ip)
                    self.assertEqual(status, 200)
                    self.assertEqual(out[field], [])
                self.assertEqual(upstream.call_count, 2)
                self.assertEqual([v.kwargs["real_ip"] for v in upstream.call_args_list],
                                 ["198.51.100.21", "198.51.100.22"])
                self.assertEqual(upstream.call_args.args[1], {"id": 1})

    def test_upstream_error_or_malformed_data_is_not_cached_as_empty_success(self):
        for path in ("/song/qualities", "/song/chorus", "/song/versions"):
            for bad in ({"code": 500}, {"code": 200, "success": False}, {"data": "unexpected"}):
                with mock.patch.object(cm_ncm, "call", return_value=bad) as upstream:
                    for _ in range(2):
                        self.assertEqual(self.call("GET", path + "?id=77")[0], 502)
                    self.assertEqual(upstream.call_count, 2)


if __name__ == "__main__":
    unittest.main()
