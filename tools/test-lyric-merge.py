#!/usr/bin/env python3
"""歌词翻译合并的离线回归测试（纯标准库，不联网）。

背景（用户反馈"部分英文歌词翻译显示不全"）：
NCM 同一首歌可能同时给 YRC（逐字）与 LRC 两份歌词——**文本同源但时间轴不同**。
实测 Someone Like You 的 lrc-yrc 行时间差中位 -931ms、最大 1705ms，且 67 个互不
相同的值（不是常数偏移）；而 tlyric（翻译）只与 **LRC** 精确对齐。
旧实现固定拿 YRC 当基准做时间最近邻（容差 350ms）→ 68 条翻译丢掉 55 条。

本测试用合成数据复现该场景，锁定 _aux_for / _merge_aux_by_text 的行为。
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))
import cm_ncm  # noqa: E402

FAIL = []


def ok(label, cond):
    print(("  ✅ " if cond else "  ❌ ") + label)
    if not cond:
        FAIL.append(label)


EN = ["I heard", "That you are settled down", "That you found a girl", "And you are married now"]
ZH = ["听说", "你心有所属", "你遇到了她", "已经步入婚姻殿堂"]


def make_tracks(shift_ms):
    """构造：YRC 与 LRC 文本相同、时间相差 shift_ms（YRC 晚）；翻译与 LRC 完全对齐。"""
    lrc = [(10000 + i * 4000, t) for i, t in enumerate(EN)]
    yrc = [(t + shift_ms, text) for t, text in lrc]
    aux = [(t, z) for (t, _e), z in zip(lrc, ZH)]
    return yrc, lrc, aux


print("① 报告的场景：YRC 与 LRC 时间轴不同，翻译只与 LRC 对齐")
yrc, lrc, aux = make_tracks(931)
got = cm_ncm._aux_for(yrc, lrc, aux)
ok("每一条翻译都落到了行上（%d/%d）" % (len(got), len(aux)), len(got) == len(aux))
ok("映射按文本正确配对（第 2 行）", got.get(1) == ZH[1])
old_hits = len(cm_ncm._merge_aux(yrc, aux))
ok("旧实现只按 YRC 时间合并会丢（%d/%d）" % (old_hits, len(aux)), old_hits < len(aux))

print("② 常规情况：翻译与 YRC 对齐（不应改变行为）")
yrc2, lrc2, aux2 = make_tracks(0)
got2 = cm_ncm._aux_for(yrc2, lrc2, aux2)
ok("全部命中（%d/%d）" % (len(got2), len(aux2)), len(got2) == len(aux2))
ok("与旧实现结果一致", got2 == {i: v for i, v in cm_ncm._merge_aux(yrc2, aux2).items() if v})

print("③ 没有 LRC（只有一份歌词）时仍按时间合并")
yrc3, _lrc3, aux3 = make_tracks(0)
got3 = cm_ncm._aux_for(yrc3, None, aux3)
ok("全部命中（%d/%d）" % (len(got3), len(aux3)), len(got3) == len(aux3))

print("④ 副歌重复文本：多次出现按顺序各消费一条翻译")
# 真实形态：副歌在基准轨里也有第二遍，只是时间与渲染轨不同
lrc4 = [(10000, "I heard"), (14000, "That you are settled down"),
        (30000, "I heard"), (34000, "That you found a girl")]
lines4 = [(t + 931, x) for t, x in lrc4]             # 渲染轨（YRC）时间轴整体偏移
aux4 = [(10000, "第一遍"), (14000, ZH[1]), (30000, "第二遍"), (34000, ZH[2])]
got4 = cm_ncm._aux_for(lines4, lrc4, aux4)
ok("四行各自拿到翻译", len([v for v in got4.values() if v]) == 4)
ok("重复行按顺序取值（%s / %s）" % (got4.get(0), got4.get(2)),
   got4.get(0) == "第一遍" and got4.get(2) == "第二遍")

print("⑤ 文本对不上时退回时间最近邻（不能因为匹配不上就不显示）")
yrc5, lrc5, aux5 = make_tracks(0)
lines5 = [(t, "different text") for t, _ in yrc5]
got5 = cm_ncm._aux_for(lines5, lrc5, aux5)
ok("仍通过时间兜底拿到翻译（%d 条）" % len([v for v in got5.values() if v]),
   len([v for v in got5.values() if v]) == len(aux5))

print("⑥ 解析：一行多时间标签要逐个展开，空翻译不参与展示")
parsed = cm_ncm._parse_lrc("[00:01.000][00:02.500]hi\n[00:03.000]")
ok("多标签展开为三条", len(parsed) == 3)
ok("空文本条目的翻译为空串", dict(parsed).get(3000) == "")

print("⑦ 无官方 YRC：按行时长估算逐字时间（日语按字 / 英文按词）")
ja = "君の知らない物語"
wj = cm_ncm._synth_words(ja, 10000, 15000)
ok("拼接后与原文完全一致", "".join(t for _, t in wj) == ja)
ok("每个字都有时间点（%d 个）" % len(wj), len(wj) == len(ja))
ok("时间从行首开始且不晚于行尾", wj[0][0] == 10000 and wj[-1][0] < 15000)
we = cm_ncm._synth_words("Hello world", 1000, 3000)
ok("英文以单词为 token", [t for _, t in we] == ["Hello", " ", "world"])
ok("英文拼接回原文", "".join(t for _, t in we) == "Hello world")
ok("超长空档时限幅 8 秒", cm_ncm._synth_words("a", 0, 30000)[-1][0] <= 8000)

print()
if FAIL:
    print("  失败 %d 项：" % len(FAIL))
    for f in FAIL:
        print("    - " + f)
    sys.exit(1)
print("  全部通过 ✅")
