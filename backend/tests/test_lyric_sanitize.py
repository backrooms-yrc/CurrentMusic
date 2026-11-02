import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import cm_lddc  # noqa: E402


def L(t, txt, w=None, **kw):
    line = {"t": t, "txt": txt, "trans": "", "roma": ""}
    if w is not None:
        line["w"] = w
    line.update(kw)
    return line


class TestFinalizeLines(unittest.TestCase):
    def test_credit_lines_preserved(self):
        # 制作名单保留（网易云 App 同样展示），只修时间轴、不删内容
        lines = [
            L(0, "作词 : 田冉", [[0, "作"], [0, "词"], [0, " : "], [0, "田"], [0, "冉"]]),
            L(0, "作曲 : 郑健", [[0, "作"], [0, "曲"], [0, " : "], [0, "郑"], [0, "健"]]),
            L(300, "Lyrics：田冉", []),
            L(400, "第一句歌词", [[400, "第一句歌词"]]),
            L(4000, "Recording：XXX", []),
            L(5000, "第二句歌词", [[5000, "第二句歌词"]]),
        ]
        out = cm_lddc.finalize_lines(lines)
        self.assertEqual([l["txt"] for l in out],
                         ["作词 : 田冉", "作曲 : 郑健", "Lyrics：田冉", "第一句歌词",
                          "Recording：XXX", "第二句歌词"])

    def test_name_list_preserved_tokens_sanitized(self):
        # 无角色前缀的人名列表同样保留；同起始 token 合并而非删除整行
        lines = [
            L(0, "田郑健王磊", [[0, "田"], [0, "郑"], [0, "健"], [0, "王"], [0, "磊"]]),
            L(1200, "正文歌词", [[1200, "正文歌词"]]),
        ]
        out = cm_lddc.finalize_lines(lines)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]["txt"], "田郑健王磊")
        self.assertEqual("".join(x[1] for x in out[0]["w"]), "田郑健王磊")

    def test_duplicate_t_bumped_strictly_increasing(self):
        lines = [
            L(0, "零秒甲", [[0, "零秒甲"]]),
            L(0, "零秒乙", [[0, "零秒乙"]]),
            L(0, "零秒丙", [[0, "零秒丙"]]),
            L(900, "下一句", [[900, "下一句"]]),
        ]
        out = cm_lddc.finalize_lines(lines)
        ts = [l["t"] for l in out]
        self.assertEqual(ts, sorted(ts))
        self.assertEqual(len(set(ts)), len(ts))
        self.assertTrue(all(b > a for a, b in zip(ts, ts[1:])))

    def test_equal_start_tokens_merged_and_join_kept(self):
        # 同起始 token → 合并；拼接必须仍等于 txt（CMX 解析器的硬条件）
        line = L(500, "hello world", [[500, "hel"], [500, "lo"], [700, " wo"], [900, "rld"]])
        out = cm_lddc.finalize_lines([line, L(2000, "next")])
        w = out[0]["w"]
        self.assertEqual("".join(x[1] for x in w), "hello world")
        starts = [x[0] for x in w]
        self.assertTrue(all(b > a for a, b in zip(starts, starts[1:])), starts)
        words = out[0]["words"]
        self.assertTrue(all(x["end"] > x["start"] for x in words))
        self.assertEqual("".join(x["text"] for x in words), "hello world")

    def test_words_rebuilt_strictly_monotonic(self):
        line = L(0, "零时长", [[0, "零"], [0, "时"], [0, "长"]])
        out = cm_lddc.finalize_lines([line, L(3000, "下一句")])
        words = out[0]["words"]
        self.assertEqual(len(words), 1)          # 三个同起始 token 合并成一个
        self.assertEqual(words[0]["text"], "零时长")
        self.assertGreater(words[0]["end"], words[0]["start"])

    def test_join_mismatch_drops_words_not_line(self):
        line = L(0, "正文", [[0, "别的"], [100, "词"]])   # 拼接对不上 txt
        out = cm_lddc.finalize_lines([line, L(2000, "下句")])
        self.assertEqual(out[0]["txt"], "正文")            # 行保留
        self.assertNotIn("w", out[0])
        self.assertNotIn("words", out[0])

    def test_trans_preserved(self):
        line = L(0, "hi", [[0, "hi"]], trans="你好")
        out = cm_lddc.finalize_lines([line])
        self.assertEqual(out[0]["trans"], "你好")

    def test_sorted_output(self):
        out = cm_lddc.finalize_lines([L(2000, "b", [[2000, "b"]]), L(1000, "a", [[1000, "a"]])])
        self.assertEqual([l["txt"] for l in out], ["a", "b"])

    def test_long_credit_run_preserved(self):
        # 《沉沦与遐想》实际形态：11 行连续制作名单（作词→母带，0~17s）全部保留
        lines = [
            L(0, "作词: C.HØPE"), L(630, "作曲: C.HØPE"), L(1260, "制作人: 王晓夫"),
            L(1890, "编曲: 王晓夫"), L(2521, "出品：网易音乐人x青云LAB"),
            L(4771, "编曲：Mantra/王晓夫"), L(7020, "人声制作：王晓夫"),
            L(9521, "和声编写/配唱：王晓夫"), L(11271, "录音：王晓夫"),
            L(14521, "混音：王晓夫"), L(16966, "母带：王晓夫"),
            L(19215, "if we never wake up"), L(21466, "我想牵你的手"),
        ]
        out = cm_lddc.finalize_lines(lines)
        self.assertEqual(len(out), 13)
        self.assertEqual(out[0]["txt"], "作词: C.HØPE")
        self.assertEqual(out[11]["txt"], "if we never wake up")


class TestBilingualMerge(unittest.TestCase):
    def test_merges_foreign_original_and_chinese_translation(self):
        # 《Dauntless (无畏Funk)》实测形态：LRC 把原文和中文译文写成不同时间的两行
        lines = [
            L(0, "作词: XiRXG"), L(340, "作曲: XiRXG"), L(680, "编曲: XiRXG"),
            L(1020, "Que porra, oi oi oi oi oi oi oi."),
            L(4093, "我的发，喂喂喂喂喂喂喂。"),
            L(8711, "Essa é a tua cidade, ei, sente o baixo que é de qualidade."),
            L(12079, "这是你的城市，嘿，感受这超顶的贝斯质感。"),
            L(27753, "Wada wada wada wada preto, no ritmo que é nosso assunto."),
            L(39170, "哇达哇达哇达黑色，在这节奏里我们做主。"),
            L(53350, "Wada wada wada wada wada wada wada wada preto, no som que é bem construído."),
            L(62522, "哇达哇达哇达哇达哇达哇达哇达黑色，这声音完美打造。"),
        ]
        out = cm_lddc.merge_bilingual(lines)
        self.assertEqual(len(out), 7)          # 3 credits + 4 merged lines
        self.assertEqual(out[0]["txt"], "作词: XiRXG")
        self.assertEqual(out[3]["txt"], "Que porra, oi oi oi oi oi oi oi.")
        self.assertEqual(out[3]["trans"], "我的发，喂喂喂喂喂喂喂。")
        self.assertEqual(out[4]["trans"], "这是你的城市，嘿，感受这超顶的贝斯质感。")
        self.assertEqual(out[5]["trans"], "哇达哇达哇达黑色，在这节奏里我们做主。")
        self.assertEqual(out[6]["trans"], "哇达哇达哇达哇达哇达哇达哇达黑色，这声音完美打造。")
        # 译文不应再作为主歌词出现
        self.assertNotIn("哇达哇达哇达黑色，在这节奏里我们做主。", [l["txt"] for l in out])

    def test_single_pair_not_merged(self):
        # 只有一组时可能是正常双语段，不冒险改结构
        lines = [L(1000, "Hello world"), L(2500, "你好世界")]
        self.assertEqual(cm_lddc.merge_bilingual(lines), lines)

    def test_existing_translation_not_merged(self):
        lines = [L(1000, "Hello", trans="你好"), L(2500, "你好"), L(4000, "Bye"), L(5200, "再见")]
        self.assertEqual(cm_lddc.merge_bilingual(lines), lines)

    def test_credits_preserved(self):
        lines = [L(0, "作词: X"), L(300, "作曲: Y"),
                 L(1000, "Hello"), L(2000, "你好"),
                 L(3000, "World"), L(4000, "世界"),
                 L(5000, "Again"), L(6000, "再来"),
                 L(7000, "End"), L(8000, "结束")]
        out = cm_lddc.merge_bilingual(lines)
        self.assertEqual([l["txt"] for l in out][:2], ["作词: X", "作曲: Y"])
        self.assertEqual([l["trans"] for l in out][2:], ["你好", "世界", "再来", "结束"])

    def test_sparse_mixed_lines_not_merged(self):
        # 实测《Cause you know》的误判形态：中英文交替但只有 2~3 组，不能当译文
        lines = [L(1000, "因为回忆里 哭泣的你"), L(7000, "Cause you know"),
                 L(9000, "爱意就像大雨落下"), L(12000, "怎么能让人不牵挂")]
        self.assertEqual(cm_lddc.merge_bilingual(lines), lines)


class TestMetadataLineVariants(unittest.TestCase):
    def test_no_space_hyphen_with_matching_artist(self):
        # 酷狗常见无空格「歌名-歌手」：旧实现只认 " - "，整行漏过
        meta = {"title": "沉沦与遐想", "artists": ["路易斯"]}
        self.assertTrue(cm_lddc._is_metadata_line({"t": 0, "txt": "沉沦与遐想-路易斯"}, meta))

    def test_spaced_and_dash_variants(self):
        meta = {"title": "沉沦与遐想", "artists": ["C.HØPE"]}
        self.assertTrue(cm_lddc._is_metadata_line({"t": 0, "txt": "沉沦与遐想 - 群星"}, meta))
        self.assertTrue(cm_lddc._is_metadata_line({"t": 0, "txt": "沉沦与遐想—C.HØPE"}, meta))
        self.assertTrue(cm_lddc._is_metadata_line({"t": 0, "txt": "沉沦与遐想－C.HØPE"}, meta))

    def test_foreign_artist_title_line_not_forced(self):
        # 标题行歌手与元数据不符（同名异曲的标志）：本函数不做整轨判断，
        # 交给 _match_verified 拒绝整轨；此处不删行，避免误伤以歌名开头的正文
        meta = {"title": "沉沦与遐想", "artists": ["C.HØPE"]}
        self.assertFalse(cm_lddc._is_metadata_line({"t": 0, "txt": "沉沦与遐想-路易斯"}, meta))

    def test_real_lyric_not_dropped(self):
        meta = {"title": "沉沦与遐想", "artists": ["C.HØPE"]}
        self.assertFalse(cm_lddc._is_metadata_line({"t": 300, "txt": "沉沦与遐想-梦想的远方"}, meta))

    def test_late_line_ignored(self):
        meta = {"title": "沉沦与遐想", "artists": ["C.HØPE"]}
        self.assertFalse(cm_lddc._is_metadata_line({"t": 5000, "txt": "沉沦与遐想-路易斯"}, meta))


class TestMatchVerified(unittest.TestCase):
    def test_artist_contains(self):
        meta = {"artists": ["C.HØPE"], "duration": 153600}
        self.assertTrue(cm_lddc._match_verified(meta, {"artist": "C.HØPE/阿云", "duration": 153000}))

    def test_wrong_artist_rejected(self):
        meta = {"artists": ["C.HØPE"], "duration": 153600}
        self.assertFalse(cm_lddc._match_verified(meta, {"artist": "路易斯", "duration": 180000}))

    def test_no_candidate_artist_duration_ok(self):
        meta = {"artists": ["某人"], "duration": 153600}
        self.assertTrue(cm_lddc._match_verified(meta, {"artist": "", "duration": 155000}))
        self.assertFalse(cm_lddc._match_verified(meta, {"artist": "", "duration": 200000}))
        self.assertFalse(cm_lddc._match_verified(meta, {"artist": "", "duration": None}))

    def test_no_meta_artist_passes(self):
        self.assertTrue(cm_lddc._match_verified({"artists": [], "duration": 0}, {"artist": "谁", "duration": 1}))
        self.assertTrue(cm_lddc._match_verified({"artists": ["A"], "duration": 1}, None))


if __name__ == "__main__":
    unittest.main()
