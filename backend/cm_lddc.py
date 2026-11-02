"""LDDC 逐字歌词 provider：本机 HTTP 客户端 + 归一化/合并。

LDDC (https://github.com/chenmozhijin/LDDC) 是 GPL-3.0 的独立歌词工具。
本项目**不复制、不链接**其代码，而是在独立虚拟环境中以本机 HTTP 服务运行
（tools/lddc_bridge.py），后端只消费归一化后的 JSON。这样 backend 仍保持
纯标准库，LDDC 也可单独升级/停用。

链路：网易云官方 YRC → LDDC（QQ/酷狗/网易云等逐字源）→ 自研逐字估算。
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.request
from bisect import bisect_left, bisect_right
from collections import defaultdict

log = logging.getLogger("cm.lddc")

LDDC_URL = os.environ.get("CM_LDDC_URL", "").rstrip("/")
LDDC_TOKEN = os.environ.get("CM_LDDC_TOKEN", "")
LDDC_TIMEOUT = float(os.environ.get("CM_LDDC_TIMEOUT", "7"))
SYNTH_RETRY_TTL = int(os.environ.get("CM_LDDC_RETRY_TTL", str(2 * 3600)))

_cb_lock = threading.Lock()
_cb_failures = 0
_cb_open_until = 0.0
_CB_THRESHOLD = 3
_CB_COOLDOWN = 120.0


def enabled():
    return bool(LDDC_URL)


def _circuit_available():
    with _cb_lock:
        return time.time() >= _cb_open_until


def _record(ok):
    global _cb_failures, _cb_open_until
    with _cb_lock:
        if ok:
            _cb_failures = 0
            _cb_open_until = 0.0
            return
        _cb_failures += 1
        if _cb_failures >= _CB_THRESHOLD:
            _cb_open_until = time.time() + _CB_COOLDOWN


def _simplify(text):
    """用于跨源对齐的紧凑文本：忽略空白、大小写和常见标点。"""
    return re.sub(r"[\s\u3000·・.,，。!！?？:：;；'\"“”‘’()（）\[\]【】<>《》/\\\-—_~～]+",
                  "", (text or "").lower())


def _tokens_text(words):
    return "".join((w.get("text") or "") for w in words)


def _trim_words(raw_words, line_start, line_end):
    """清洗 LDDC 的逐字数据，并去掉行首/行尾空白 token。"""
    clean = []
    last = int(line_start)
    for item in raw_words or []:
        if not isinstance(item, dict):
            continue
        text = item.get("text")
        if not isinstance(text, str):
            continue
        start = item.get("start")
        end = item.get("end")
        if not isinstance(start, int):
            start = last
        if not isinstance(end, int) or end < start:
            end = start
        start = max(0, start, last)
        end = max(start, end)
        if line_end and end > line_end:
            end = line_end
        clean.append([start, end, text])
        last = start

    while clean and not clean[0][2].strip():
        clean.pop(0)
    while clean and not clean[-1][2].strip():
        clean.pop()
    if not clean:
        return []
    clean[0][2] = clean[0][2].lstrip()
    clean[-1][2] = clean[-1][2].rstrip()
    if not clean[0][2]:
        clean.pop(0)
    if clean and not clean[-1][2]:
        clean.pop()
    return clean


def _align_aux(orig, aux):
    """把翻译/罗马音按「同长度直接对齐 → 时间最近邻」映射到主歌词行。"""
    out = [""] * len(orig)
    if not aux:
        return out
    timed = [(i, int(item.get("start"))) for i, item in enumerate(aux)
             if isinstance(item.get("start"), int)]
    if not timed:
        return out

    if len(timed) == len(orig):
        close = sum(1 for i, (_, t) in enumerate(timed)
                    if isinstance(orig[i].get("start"), int)
                    and abs(int(orig[i]["start"]) - t) <= 80)
        if close >= int(len(orig) * 0.85):
            for i, (ai, _) in enumerate(timed):
                out[i] = _tokens_text(aux[ai].get("words") or [])
            return out

    times = [t for _, t in timed]
    used = set()
    for i, line in enumerate(orig):
        start = line.get("start")
        if not isinstance(start, int):
            continue
        lo = bisect_left(times, start - 700)
        hi = bisect_right(times, start + 700)
        candidates = sorted((abs(times[j] - start), j) for j in range(lo, hi) if j not in used)
        if candidates:
            _, j = candidates[0]
            ai, _ = timed[j]
            used.add(j)
            out[i] = _tokens_text(aux[ai].get("words") or [])
    return out


def _is_metadata_line(line, meta):
    """识别 KRC 的 `歌名 - 群星/歌手...` 首行元数据，避免当成歌词唱出来。

    分隔符必须兼容**无空格**形态：酷狗常写成「沉沦与遐想-路易斯」，
    只认带空格的 " - " 会整行漏过（用户反馈的错乱歌曲正是这种）。
    """
    text = (line.get("txt") or "").strip()
    start = line.get("t")
    if not text or not isinstance(start, int) or start > 600:
        return False
    title = _simplify(meta.get("title") or "")
    compact = _simplify(text)
    if not title or not compact.startswith(title):
        return False
    split_at = -1
    for sep in (" - ", " – ", " — ", "-", "‐", "‑", "–", "—", "－", "~", "〜"):
        if sep in text:
            split_at = text.index(sep)
            break
    if split_at < 0:
        return False
    rest = text[split_at + 3 if text[split_at:split_at + 3] in (" - ", " – ", " — ") else split_at + 1:]
    compact_rest = _simplify(rest)
    artists = [a for a in (meta.get("artists") or []) if a]
    artist_hit = any(_simplify(a) and _simplify(a) in compact_rest for a in artists)
    return bool(artist_hit or "/" in rest or "群星" in rest)


def _validate_normalized(payload, meta, allow_line=False):
    """校验桥接服务已经归一化过的 lines，防止本地服务异常时污染客户端。"""
    raw_lines = payload.get("lines")
    if not isinstance(raw_lines, list):
        return None
    out = []
    word_lines = 0
    for raw in raw_lines[:2000]:
        if not isinstance(raw, dict):
            continue
        try:
            t = int(raw.get("t"))
        except (TypeError, ValueError):
            continue
        txt = raw.get("txt")
        if not isinstance(txt, str) or not txt.strip() or t < 0:
            continue
        line = {
            "t": t,
            "txt": txt.strip(),
            "trans": raw.get("trans") if isinstance(raw.get("trans"), str) else "",
            "roma": raw.get("roma") if isinstance(raw.get("roma"), str) else "",
        }
        words = []
        for item in raw.get("words") or []:
            if not isinstance(item, dict):
                continue
            try:
                start = int(item.get("start"))
                end = int(item.get("end"))
            except (TypeError, ValueError):
                continue
            text = item.get("text")
            if not isinstance(text, str):
                continue
            words.append({"start": max(0, start), "end": max(start, end), "text": text})
        w = []
        for item in raw.get("w") or []:
            if not isinstance(item, (list, tuple)) or len(item) < 2:
                continue
            try:
                start = int(item[0])
            except (TypeError, ValueError):
                continue
            if not isinstance(item[1], str):
                continue
            w.append([max(0, start), item[1]])
        if w and "".join(x[1] for x in w) != line["txt"]:
            w = []
        if not w and len(words) >= 2:
            joined = "".join(x["text"] for x in words)
            if joined.strip() == line["txt"]:
                w = [[x["start"], x["text"]] for x in words]
        if words and "".join(x["text"] for x in words).strip() != line["txt"]:
            words = []
        if w:
            line["w"] = w
            if len(w) >= 2:
                word_lines += 1
        if words:
            line["words"] = words
        if raw.get("wSynth"):
            line["wSynth"] = True
        out.append(line)

    if len(out) < 2:
        return None
    # 首行「歌名-歌手」元数据同样要剥（桥接直接返回 lines 的路径）
    while len(out) > 2 and _is_metadata_line(out[0], meta):
        out.pop(0)
    out.sort(key=lambda x: x["t"])
    word_level = word_lines >= max(2, int(len(out) * 0.5))
    if not word_level and not allow_line:
        return None
    ensure_words(out)
    return {
        "lines": out,
        "wordLevel": word_level,
        "source": str(payload.get("source") or "lddc").lower(),
    }


def normalize_provider_lyrics(payload, meta, allow_line=False):
    """把桥接服务返回的 LDDC 数据归一化成 CurrentMusic 歌词结构。

    payload.orig / ts / roma 都是 ``[{start,end,words:[{start,end,text}]}]``。
    若 payload 已经是桥接服务归一化后的 ``lines``，则走校验分支。
    返回 ``{"lines": [...], "wordLevel": bool, "source": "lddc:KG"}``；不足两行、
    没有时间轴或只有逐行歌词且调用方不允许时返回 ``None``。
    """
    if not isinstance(payload, dict):
        return None
    if "lines" in payload:
        return _validate_normalized(payload, meta, allow_line)
    orig = payload.get("orig")
    if not isinstance(orig, list) or len(orig) < 2:
        return None
    orig = orig[:2000]

    parsed = []
    for item in orig:
        if not isinstance(item, dict):
            continue
        start = item.get("start")
        if not isinstance(start, int) or start < 0:
            continue
        end = item.get("end")
        words = _trim_words(item.get("words") or [], start, end if isinstance(end, int) else None)
        text = "".join(w[2] for w in words).strip()
        if not text:
            continue
        if not isinstance(end, int) or end <= start:
            end = start + max(500, min(8000, len(text) * 120))
        parsed.append({"start": start, "end": end, "words": words, "txt": text})

    if len(parsed) < 2:
        return None
    parsed.sort(key=lambda x: x["start"])
    trans = _align_aux(parsed, payload.get("ts") or [])
    roma = _align_aux(parsed, payload.get("roma") or [])

    raw_lines = []
    for i, item in enumerate(parsed):
        words = item["words"]
        line = {
            "t": item["start"],
            "txt": item["txt"],
            "trans": trans[i],
            "roma": roma[i],
        }
        if len(words) >= 1:
            line["_end"] = item["end"]
            line["_words"] = words
        raw_lines.append(line)

    # 元数据行只可能出现在开头；最多连续检查 3 行。
    while len(raw_lines) > 2 and _is_metadata_line(raw_lines[0], meta):
        raw_lines.pop(0)

    lines = []
    word_lines = 0
    for line in raw_lines:
        if not (line.get("txt") or "").strip():
            continue
        words = line.pop("_words", [])
        end = line.pop("_end", line["t"] + 500)
        line["txt"] = line["txt"].strip()
        if words:
            line["words"] = [
                {"start": s, "end": e, "text": tx} for s, e, tx in words
            ]
            if len(words) >= 2:
                line["w"] = [[s, tx] for s, _, tx in words]
                word_lines += 1
        lines.append(line)

    if len(lines) < 2:
        return None
    word_level = word_lines >= max(2, int(len(lines) * 0.5))
    if not word_level and not allow_line:
        return None
    return {
        "lines": lines,
        "wordLevel": word_level,
        "source": str(payload.get("source") or "lddc").lower(),
    }


def ensure_words(lines):
    """为只有 w（起点）的旧结构补 CurrentMusicX 兼容的 words（带结束时间）。"""
    for i, line in enumerate(lines):
        if line.get("words") or not line.get("w"):
            continue
        w = line["w"]
        next_t = lines[i + 1]["t"] if i + 1 < len(lines) else line["t"] + 5000
        out = []
        for j, item in enumerate(w):
            if not isinstance(item, (list, tuple)) or len(item) < 2:
                continue
            start = int(item[0])
            if j + 1 < len(w):
                end = int(w[j + 1][0])
            else:
                end = min(next_t, start + 1200)
            out.append({"start": start, "end": max(start, end), "text": str(item[1])})
        if out:
            line["words"] = out


def _sanitize_words(line):
    """把一行的逐字轴修成 CMX 可用的形态，返回新的 ``w`` 列表。

    CurrentMusicX 的 LyricsParser 对 words 的要求：token 拼接 == txt、时间
    严格递增、每个 token end > start 且首 token >= 行起始，违反任何一条都会
    丢 token（整行降亮度）甚至整行丢逐字。LDDC/KRC 的原始数据常带：
      · 相邻 token 起始时间相同（制作名单排版）→ 合并进前一个 token；
      · end <= start（_trim_words 的 max 截断产物）→ 重建 words 时统一拉平；
      · 官方 YRC credits 行的零时长字 → 同上。
    合并只拼接文本，不改变整行拼接结果，txt/翻译都不受影响。
    """
    w = line.get("w")
    if not isinstance(w, list) or not w:
        return None
    tokens = []
    for item in w:
        if not isinstance(item, (list, tuple)) or len(item) < 2 or not isinstance(item[0], int):
            continue
        text = item[1]
        if not isinstance(text, str):
            continue
        tokens.append((item[0], text))
    if not tokens:
        return None
    merged = [list(tokens[0])]
    for start, text in tokens[1:]:
        if start <= merged[-1][0]:
            merged[-1][1] += text          # 同起始：并入前一 token（拼接不变）
        else:
            merged.append([start, text])
    line_start = int(line.get("t") or 0)
    if merged[0][0] < line_start:
        merged[0][0] = line_start
    out = [[start, text] for start, text in merged]
    if "".join(x[1] for x in out) != (line.get("txt") or ""):
        return None                          # 拼接对不上：宁可不给逐字，不可错位
    return out


_HAN_RE = re.compile(r"[\u3400-\u9fff]")
_LATIN_RE = re.compile(r"[A-Za-zÀ-ÖØ-öø-ÿ]")
_CREDIT_HINT = re.compile(
    r"^\s*(?:作词|作詞|作曲|编曲|編曲|制作人|製作人|监制|監制|录音|錄音|混音|母带|母帶|"
    r"和声|和聲|配唱|出品|演唱|原唱|翻唱)\s*[:：]", re.I)


def _script_kind(text):
    """粗分脚本：cjk / latin / mixed；只用于识别“原文+译文”双行，不做语言检测。"""
    t = (text or "").strip()
    if not t:
        return ""
    han = len(_HAN_RE.findall(t))
    latin = len(_LATIN_RE.findall(t))
    letters = han + latin
    if letters < 2:
        return ""
    if han >= 2 and han / letters >= 0.25:
        return "cjk"
    if latin >= 2 and han == 0:
        return "latin"
    return ""


def _pair_translation(a, b):
    """a 是原文、b 是紧随其后的译文行时返回 True。

    只在 tlyric 为空、后端拿到的是双语 LRC 时使用。要求：
      · 相邻行、时间差 1~15 秒（译文常滞后几秒，甚至跨过一小段伴奏）；
      · 脚本相反（拉丁↔汉字），且不是制作名单；
      · 两行都还没有 trans 字段。
    """
    if not isinstance(a, dict) or not isinstance(b, dict):
        return False
    if (a.get("trans") or "").strip() or (b.get("trans") or "").strip():
        return False
    ta, tb = a.get("t"), b.get("t")
    if not isinstance(ta, int) or not isinstance(tb, int):
        return False
    gap = tb - ta
    if gap < 1000 or gap > 15000:
        return False
    ka, kb = _script_kind(a.get("txt")), _script_kind(b.get("txt"))
    if {ka, kb} != {"cjk", "latin"}:
        return False
    if _CREDIT_HINT.match((a.get("txt") or "").strip()) or _CREDIT_HINT.match((b.get("txt") or "").strip()):
        return False
    return True


def merge_bilingual(lines):
    """把双语 LRC 的相邻「原文/译文」两行合成一行。

    网易云不少外语歌没有 tlyric，上传者直接把原文和中文译文写成两条带不同
    时间戳的 LRC 行。CMX/网页若逐行渲染，就会把译文也当正文唱出来；这里
    合并成 ``txt=原文, trans=译文``，并丢掉译文那条时间轴。

    误判保护：正文里本来就会交替出现中英文，单看“相邻 + 脚本相反”远远不够
    （实测《Cause you know》会被误合并）。只有在**至少 4 组配对且配对占全篇
    1/3 以上**时才启用；目标歌《Dauntless》是 7/12，误判歌只有 2~3/87。
    """
    merged = []
    i = 0
    pairs = 0
    while i < len(lines):
        a = lines[i]
        b = lines[i + 1] if i + 1 < len(lines) else None
        if b is not None and _pair_translation(a, b):
            a = dict(a)
            a["trans"] = (b.get("txt") or "").strip()
            merged.append(a)
            pairs += 1
            i += 2
        else:
            merged.append(a)
            i += 1
    if pairs >= 4 and pairs * 3 >= len(lines):
        return merged
    return lines


def finalize_lines(lines):
    """lyric() 出口的统一清洗（官方 YRC / LDDC / 估算全部经过这里）。

    修三类 CMX 侧表现为「歌词错乱」的问题：
      1. 相邻行 t 相同（KRC 常把前几行全排 t=0）→ 顺次 +1ms 保证严格递增；
      2. 逐字 token 同起始 / end<=start → 合并与拉平（见 _sanitize_words）；
      3. words 与 w 不同步 → 以清洗后的 w 重建 words。

    制作名单（作词/作曲/母带…）**保留**：网易云 App 同样展示，消费端按普通
    歌词行渲染即可；这里不动歌词内容，只修时间轴。
    """
    out = [l for l in lines if isinstance(l, dict) and (l.get("txt") or "").strip()]
    out.sort(key=lambda x: int(x.get("t") or 0))
    for i in range(1, len(out)):
        if int(out[i].get("t") or 0) <= int(out[i - 1].get("t") or 0):
            out[i]["t"] = int(out[i - 1]["t"]) + 1
    for i, line in enumerate(out):
        line_end = out[i + 1]["t"] if i + 1 < len(out) else (int(line["t"]) + 8000)
        clean = _sanitize_words(line)
        if clean is None:
            line.pop("w", None)
            line.pop("words", None)
        else:
            line["w"] = clean
            words = []
            for j, (start, text) in enumerate(clean):
                nxt = clean[j + 1][0] if j + 1 < len(clean) else max(start + 1, min(line_end, start + 800))
                words.append({"start": start, "end": max(start + 1, nxt), "text": text})
            line["words"] = words
    return out


def merge_with_base(base, external):
    """用 LDDC 逐字歌词替换主轨，同时从网易云结果补齐缺失的翻译/罗马音。

    只在 LDDC 完全没给逐字轴的某一行才回填网易云的估算轴，并保留 ``wSynth``
    标记；LDDC 的实际时间轴永不覆盖。
    """
    if not external or not external.get("lines"):
        return None
    base_lines = (base or {}).get("lines") or []
    by_text = defaultdict(list)
    for line in base_lines:
        key = _simplify(line.get("txt"))
        if key:
            by_text[key].append(line)
    used = set()

    def pick(line):
        key = _simplify(line.get("txt"))
        candidates = [x for x in by_text.get(key, []) if id(x) not in used]
        if candidates and line.get("t") is not None:
            candidates.sort(key=lambda x: abs(int(x["t"]) - int(line["t"])))
        elif not candidates and line.get("t") is not None:
            candidates = [x for x in base_lines
                          if id(x) not in used and x.get("t") is not None
                          and abs(int(x["t"]) - int(line["t"])) <= 600]
            candidates.sort(key=lambda x: abs(int(x["t"]) - int(line["t"])))
        if not candidates:
            return None
        chosen = candidates[0]
        used.add(id(chosen))
        return chosen

    out = []
    for raw in external["lines"]:
        line = dict(raw)
        if isinstance(line.get("w"), list):
            line["w"] = [list(x) for x in line["w"] if isinstance(x, (list, tuple)) and len(x) >= 2]
        b = pick(line)
        if b:
            if not line.get("trans") and b.get("trans"):
                line["trans"] = b["trans"]
            if not line.get("roma") and b.get("roma"):
                line["roma"] = b["roma"]
            if not line.get("w") and b.get("w"):
                line["w"] = [list(x) for x in b["w"] if isinstance(x, (list, tuple)) and len(x) >= 2]
                if b.get("words"):
                    line["words"] = b["words"]
                else:
                    line.pop("words", None)
                if b.get("wSynth"):
                    line["wSynth"] = True
        line.setdefault("trans", "")
        line.setdefault("roma", "")
        out.append(line)

    ensure_words(out)
    return {
        "lines": out,
        "isYrc": False,
        "source": external.get("source") or "lddc",
        "wordLevel": bool(external.get("wordLevel")),
    }


def _match_verified(meta, match):
    """复核桥接匹配到的就是「这首歌」：同名不同歌手是最常见的整轨错乱来源。

    规则（任一通过即可，全部不通过则拒绝这次 LDDC 结果）：
      · 候选歌手与元数据歌手有包含关系（简化后比对，兼容 feat / 多歌手）；
      · 候选无歌手元数据时，时长差 ≤6s 视为同一录音；
      · 本地没有歌手信息、或桥接没带 match（旧版本）：放行，保持旧行为。
    """
    if not isinstance(match, dict):
        return True
    artists = [str(a).strip() for a in (meta.get("artists") or []) if str(a).strip()]
    cand = _simplify(str(match.get("artist") or ""))
    if artists and cand:
        for a in artists:
            s = _simplify(a)
            if len(s) >= 2 and (s in cand or cand in s):
                return True
        return False
    if artists and not cand:
        try:
            dur_meta = int(meta.get("duration") or 0)
            dur_cand = int(match.get("duration") or 0)
        except (TypeError, ValueError):
            return False
        return bool(dur_meta and dur_cand and abs(dur_meta - dur_cand) <= 6000)
    return True


def fetch(meta, allow_line=False, timeout=None):
    """请求本机 LDDC 桥接服务；未配置/熔断/失败/无匹配时返回 None。"""
    if not enabled() or not _circuit_available():
        return None
    raw_artists = meta.get("artists") or []
    if isinstance(raw_artists, str):
        raw_artists = [x.strip() for x in raw_artists.split(" / ")]
    artists = [str(a).strip() for a in raw_artists if str(a).strip()]
    body = json.dumps({
        "title": meta.get("name") or "",
        "artists": artists,
        "album": meta.get("album") or "",
        "duration": int(meta.get("duration") or 0),
        "ncmId": meta.get("ncm_id") or 0,
        "allowLine": bool(allow_line),
    }, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json; charset=utf-8",
               "User-Agent": "CurrentMusic-LDDC/1.0"}
    if LDDC_TOKEN:
        headers["X-CM-LDDC-Token"] = LDDC_TOKEN
    req = urllib.request.Request(LDDC_URL + "/lyrics", data=body, headers=headers, method="POST")
    # 明确绕过环境代理：桥接只允许本机回环。
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout or LDDC_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 外部 provider 失败必须回退，不阻断歌词
        _record(False)
        log.warning("LDDC 请求失败：%s", exc)
        return None
    if not isinstance(data, dict) or not data.get("ok"):
        _record(False)
        log.warning("LDDC 返回异常：%s", str(data)[:200])
        return None
    _record(True)
    if not data.get("found"):
        return None
    check = {
        "title": meta.get("name") or "",
        "artists": artists,
        "duration": int(meta.get("duration") or 0),
    }
    match = data.get("match")
    if not _match_verified(check, match):
        m_artist = (match or {}).get("artist") if isinstance(match, dict) else ""
        m_dur = (match or {}).get("duration") if isinstance(match, dict) else ""
        log.info("LDDC 匹配复核不通过（疑似同名异曲）：meta=%s dur=%s cand=%s cand_dur=%s",
                 "/".join(artists), check["duration"], m_artist, m_dur)
        return None
    result = normalize_provider_lyrics(data, {
        "title": meta.get("name") or "",
        "artists": artists,
    }, allow_line=allow_line)
    if not result:
        log.info("LDDC 命中但归一化后不可用（%s）", data.get("source"))
        return None
    result["source"] = str(data.get("source") or result["source"]).lower()
    log.info("LDDC 命中：%s %s（%d 行，逐字=%s）",
             result["source"], meta.get("name"), len(result["lines"]), result["wordLevel"])
    return result


def cache_ttl(result):
    """只拿到网易云 LRC/估算轴时缩短缓存，给 LDDC 后续补词留出重试窗口。"""
    source = str((result or {}).get("source") or "")
    if (result or {}).get("isYrc") or source.startswith("lddc:") or source == "ncm:inst" or not enabled():
        return 7 * 86400
    return max(600, SYNTH_RETRY_TTL)
