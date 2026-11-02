"""CurrentMusicAI：聊天室里的联网问答助手（v1.28.51）。

接入 DeepSeek（默认 deepseek-flash），支持 Search / Fetch 两个联网工具：
  · 用户在 Chat 里引用一张卡片并 @CurrentMusicAI 提问；
  · 服务端异步跑「模型 → 工具调用 → 工具结果 → 模型」循环，最多 4 轮；
  · 回答以机器人账号发回聊天室（走 cm_chat.send，SSE 实时下发）。
密钥只从环境变量读取（CM_AI_KEY），不落仓库；未配置时机器人会提示未接入。
"""
from __future__ import annotations

import base64
import io
import json
import logging
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.request

import cm_chat
import cm_db
import cm_ncm

log = logging.getLogger("cm")

API_BASE = os.environ.get("CM_AI_BASE", "https://api.deepseek.com/v1").rstrip("/")
MODEL = os.environ.get("CM_AI_MODEL", "deepseek-flash")
BOT_USERNAME = "CurrentMusicAI"
BOT_NICKNAME = "CurrentMusicAI"
BOT_BIO = "我是 CurrentMusic 的 AI 助手：在 Chat 里 @我 提问，可以联网查资料、识别图片；引用歌曲卡片提问会更准确。"

MAX_ROUNDS = 4          # 模型/工具往返轮数
MAX_SEARCH = 3          # 单次请求最多搜索次数
MAX_FETCH = 1           # 单次请求最多抓取网页数
MAX_TOKENS = 2000       # 含推理 token，留足空间
ANSWER_LIMIT = 800      # AI 回复可比用户消息长；按句子边界截断
AI_IMAGE_SIDE = 1280    # 发给视觉模型的图片最长边（与聊天原图上限一致，保留文字细节）
AI_IMAGE_QUALITY = 85   # 重新编码 JPEG 的质量
COOLDOWN = 5.0          # 同一用户两次提问的最小间隔（超出则排队等待）
EFFORT = os.environ.get("CM_AI_EFFORT", "high").strip().lower()
EFFORT_LEVELS = {"none", "low", "high", "max"}   # none = 关闭思考；high 更可靠地触发联网工具
HISTORY_TURNS = 6        # 按用户保留最近 6 轮问答
HISTORY_TTL = 7 * 86400  # 上下文有效期 7 天
CLEAR_WORDS = ("清除上下文", "清空上下文", "重置对话", "忘记之前的对话",
               "忘掉之前的对话", "清除记忆", "/reset", "/clear")
CONCURRENCY = 2         # 同时进行的 AI 请求数

TYPE_LABEL = {"song": "单曲", "album": "专辑", "artist": "歌手", "playlist": "歌单"}
SUB_LABEL = {"song": "歌手", "album": "歌手", "artist": "简介", "playlist": "信息"}

SYSTEM = (
    "你是 CurrentMusicAI，CurrentMusic 音乐社区的 AI 助手。用户在聊天中向你提问。"
    "如果消息里附带「卡片信息」，请结合卡片回答；当前消息里带有卡片时以当前卡片为准，"
    "没有卡片就按问题本身回答。你可以调用 search（联网搜索）与 fetch（抓取网页）核实信息；"
    "优先用卡片或问题里的名称/歌手/专辑/作者作为搜索词。\n"
    "回答要求：\n"
    "- 中文，600 字以内；用 Markdown 排版（可用 **粗体**、- 无序列表、1. 有序列表、`行内代码`、> 引用、## 小标题；不要表格、图片、HTML）；\n"
    "- 先给结论，再给 2~4 条要点；\n"
    "- 只基于卡片信息与检索到的资料，不编造；资料不足就直说；\n"
    "- 如果用户在做追问，结合对话上下文理解“它/这首歌/这位歌手”指代的对象；\n"
    "- 如果用户消息附带图片，先理解图片内容，再结合问题回答；看不清就直说，不要臆测；\n"
    "- 如果回答围绕用户引用的卡片，可以调用 attach_card 附上该卡片（用卡片信息里的类型/ID/名称）；\n"
    "- 如果推荐具体的歌曲/专辑/歌手/歌单，先调用 search_music 找站内条目，再用 attach_card 附上（最多 3 张，不要编造 ID）；\n"
    "- attach_card 的 id/type 只能来自 search_music 的结果或用户引用的卡片；同一部作品只附一张；同名翻唱/同人条目只有在歌手也吻合时才附，拿不准就不附；\n"
    "- 用户明确要求“附卡片/带上歌曲”时，必须在最终回复前调用 attach_card；只有确实附加成功、且回复里的卡片会展示给用户时，才能说“卡片已附”；\n"
    "- 不要输出工具调用过程、搜索链接清单或“根据搜索结果”这类套话。"
)

TOOLS = [
    {"type": "function", "function": {
        "name": "search", "description": "联网搜索，返回若干网页的标题、链接与摘要。",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string", "description": "搜索关键词"}},
            "required": ["query"]}}},
    {"type": "function", "function": {
        "name": "fetch", "description": "抓取一个网页的正文（用于核对细节）。",
        "parameters": {"type": "object", "properties": {
            "url": {"type": "string", "description": "要抓取的网页 URL"}},
            "required": ["url"]}}},
    {"type": "function", "function": {
        "name": "search_music", "description": "搜索 CurrentMusic 站内条目，返回可附卡片的 ID。",
        "parameters": {"type": "object", "properties": {
            "type": {"type": "string", "enum": ["song", "album", "artist", "playlist"]},
            "query": {"type": "string", "description": "歌名/歌手/专辑/歌单关键词"}},
            "required": ["type", "query"]}}},
    {"type": "function", "function": {
        "name": "attach_card", "description": "把一张音乐卡片附加到本次回复（最多 3 张）。",
        "parameters": {"type": "object", "properties": {
            "type": {"type": "string", "enum": ["song", "album", "artist", "playlist"]},
            "id": {"type": "integer"},
            "name": {"type": "string"},
            "sub": {"type": "string"},
            "pic": {"type": "string"}},
            "required": ["type", "id", "name"]}}},
]

_uid = None
_last: dict = {}
_pending: set = set()
_lock = threading.Lock()
_sem = threading.Semaphore(CONCURRENCY)


class AiError(Exception):
    pass


def api_ready() -> bool:
    return bool(os.environ.get("CM_AI_KEY", "").strip())


def bot_uid():
    global _uid
    if _uid:
        return _uid
    u = cm_db.get_user_by_name(BOT_USERNAME)
    if u:
        _uid = u["id"]
    return _uid


def bot_user():
    uid = bot_uid()
    return cm_db.get_user(uid) if uid else None


# ---------------------------------------------------------------- 账号与头像

def _make_avatar(fp: str):
    """生成机器人头像：渐变底 + 白色圆角机器人脸 + 天线 + 微笑 + 底部 AI。"""
    from PIL import Image, ImageDraw, ImageFont
    S = 512
    img = Image.new("RGB", (S, S))
    d = ImageDraw.Draw(img)
    c1, c2 = (108, 78, 246), (24, 14, 44)
    for y in range(S):
        t = y / (S - 1)
        d.line([(0, y), (S, y)], fill=tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3)))
    d.rounded_rectangle([96, 128, 416, 400], radius=86, fill=(247, 247, 255))
    d.line([(256, 128), (256, 80)], fill=(247, 247, 255), width=12)
    d.ellipse([236, 44, 276, 84], fill=(120, 205, 255))
    d.ellipse([166, 218, 226, 278], fill=(52, 36, 110))
    d.ellipse([286, 218, 346, 278], fill=(52, 36, 110))
    d.arc([190, 268, 322, 360], start=20, end=160, fill=(52, 36, 110), width=14)
    try:
        font = ImageFont.truetype(
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 72)
        d.text((256, 456), "AI", font=font, fill=(225, 220, 255), anchor="mm")
    except Exception:  # noqa: BLE001 字体缺失就只留机器人脸
        pass
    img.save(fp, "JPEG", quality=92, optimize=True)


def ensure_bot(avatar_dir: str):
    """幂等创建/修正 CurrentMusicAI 账号。返回 uid。"""
    global _uid
    u = cm_db.get_user_by_name(BOT_USERNAME)
    if not u:
        uid = cm_db.create_user(BOT_USERNAME, secrets.token_hex(24), BOT_NICKNAME)
        u = cm_db.get_user(uid)
        log.info("已创建 AI 账号 uid=%s", uid)
    uid = u["id"]
    avatar = u.get("avatar") or ""
    fp = os.path.join(avatar_dir, f"{uid}.jpg")
    if not avatar or not os.path.isfile(os.path.join(avatar_dir, avatar)):
        try:
            os.makedirs(avatar_dir, exist_ok=True)
            _make_avatar(fp)
            avatar = f"{uid}.jpg"
        except Exception as e:  # noqa: BLE001 头像失败不影响账号
            log.warning("AI 头像生成失败: %s", e)
    conn = cm_db.connect()
    try:
        conn.execute(
            "UPDATE users SET is_bot=1, title='', bio=?, public_square=0, nickname=?, avatar=? WHERE id=?",
            (BOT_BIO, BOT_NICKNAME, avatar, uid))
        conn.commit()
    finally:
        conn.close()
    _uid = uid
    _init_history()
    return uid


# ---------------------------------------------------------------- 对话上下文

def _init_history():
    conn = cm_db.connect()
    try:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS ai_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT 'chat',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_history_user ON ai_history(user_id, id);
        """)
        # v1.28.61：播放页「问AI」与公共 Chat 的上下文隔离，老库补列。
        cols = [r[1] for r in conn.execute("PRAGMA table_info(ai_history)")]
        if "scope" not in cols:
            conn.execute("ALTER TABLE ai_history ADD COLUMN scope TEXT NOT NULL DEFAULT 'chat'")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_ai_history_scope ON ai_history(user_id, scope, id)")
        conn.execute("DELETE FROM ai_history WHERE created_at < ?",
                     (int(time.time()) - HISTORY_TTL,))
        conn.commit()
    finally:
        conn.close()


def load_history(uid: int, scope: str = "chat"):
    """按用户+场景取最近 6 轮问答（7 天内），按时间正序。"""
    conn = cm_db.connect()
    try:
        rows = conn.execute(
            "SELECT role, content FROM ai_history WHERE user_id=? AND scope=? AND created_at>=?"
            " ORDER BY id DESC LIMIT ?",
            (int(uid), scope, int(time.time()) - HISTORY_TTL, HISTORY_TURNS * 2)).fetchall()
        out = [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]
        return out
    finally:
        conn.close()


def append_history(uid: int, role: str, content: str, scope: str = "chat"):
    content = (content or "").strip()[:800]
    if not content:
        return
    conn = cm_db.connect()
    try:
        conn.execute(
            "INSERT INTO ai_history(user_id, role, content, scope, created_at) VALUES(?,?,?,?,?)",
            (int(uid), role, content, scope, int(time.time())))
        old = conn.execute(
            "SELECT id FROM ai_history WHERE user_id=? AND scope=? ORDER BY id DESC LIMIT 1 OFFSET ?",
            (int(uid), scope, HISTORY_TURNS * 2)).fetchone()
        if old:
            conn.execute("DELETE FROM ai_history WHERE user_id=? AND scope=? AND id<=?",
                         (int(uid), scope, old["id"]))
        conn.commit()
    finally:
        conn.close()


def clear_history(uid: int, scope: str = "chat"):
    conn = cm_db.connect()
    try:
        conn.execute("DELETE FROM ai_history WHERE user_id=? AND scope=?", (int(uid), scope))
        conn.commit()
    finally:
        conn.close()


def is_clear_command(text: str) -> bool:
    t = (text or "").strip().lower()
    return len(t) <= 20 and any(w in t for w in CLEAR_WORDS)


def user_turn(card: str, question: str, has_image: bool = False) -> str:
    q = (question or "").strip()
    if card:
        default = "请结合图片和卡片信息回答。" if has_image else "请介绍一下这张卡片"
        return f"卡片信息：\n{card}\n\n问题：{q or default}"
    return q or ("请看看这张图片，并回答。" if has_image else "请介绍一下这张卡片")


def _image_data_url(filename: str) -> str:
    """把聊天图片压成 ≤1024px 的 JPEG data URL，供视觉模型直接读取。

    DeepSeek 的图片输入只稳定接受 data URL（远程 URL 会被判为 unsupported
    image）；聊天图片本来就在本机，直接 base64 最稳，也能控制尺寸和体积。
    """
    fp = cm_chat.image_path(filename)
    if not fp:
        return ""
    try:
        with open(fp, "rb") as f:
            raw = f.read()
    except OSError:
        return ""
    try:
        from PIL import Image, ImageOps
        import cm_image
        im = cm_image.open_image(raw, formats=("JPEG", "PNG", "WEBP", "GIF"))
        try:
            im = ImageOps.exif_transpose(im)
        except Exception:  # noqa: BLE001 个别格式不支持 EXIF 方向
            pass
        if getattr(im, "is_animated", False):
            try:
                im.seek(0)
            except Exception:  # noqa: BLE001
                pass
        im.thumbnail((AI_IMAGE_SIDE, AI_IMAGE_SIDE))
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=AI_IMAGE_QUALITY, optimize=True)
        raw = buf.getvalue()
        mime = "image/jpeg"
    except ValueError as e:
        log.warning("AI 图片尺寸/格式被拒绝: %s", e)
        return ""
    except Exception as e:  # noqa: BLE001 Pillow 缺失/损坏时退回原图
        log.warning("AI 图片压缩失败，使用原图: %s", e)
        ext = fp.rsplit(".", 1)[-1].lower()
        mime = {"jpg": "image/jpeg", "png": "image/png",
                "gif": "image/gif", "webp": "image/webp"}.get(ext, "image/jpeg")
    if len(raw) > 1_800_000:
        log.warning("AI 图片过大，已跳过: %s", filename)
        return ""
    return f"data:{mime};base64,{base64.b64encode(raw).decode()}"


def user_message(card: str, question: str, image_url: str = ""):
    """构造本轮 user 消息；有图时用 OpenAI 多模态 content 数组。"""
    text = user_turn(card, question, bool(image_url))
    if not image_url:
        return {"role": "user", "content": text}
    return {"role": "user", "content": [
        {"type": "text", "text": text},
        {"type": "image_url", "image_url": {"url": image_url}},
    ]}


# ---------------------------------------------------------------- DeepSeek

def _post(path: str, payload: dict, timeout: float = 60.0):
    key = os.environ.get("CM_AI_KEY", "").strip()
    if not key:
        raise AiError("AI 未配置")
    req = urllib.request.Request(
        API_BASE + path, data=json.dumps(payload, ensure_ascii=False).encode(),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            msg = e.read().decode("utf-8", "replace")[:300]
        except Exception:  # noqa: BLE001
            msg = ""
        raise AiError(f"上游 HTTP {e.code}：{msg}")
    except Exception as e:  # noqa: BLE001
        raise AiError(f"上游请求失败：{e}")


def _chat(messages, tools=None):
    payload = {"model": MODEL, "messages": messages,
               "max_tokens": MAX_TOKENS, "temperature": 0.6}
    if EFFORT in EFFORT_LEVELS:
        payload["reasoning_effort"] = EFFORT
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    d = _post("/chat/completions", payload, timeout=90.0)
    try:
        return d["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        raise AiError("模型响应格式异常")


def _has_dsml(text: str) -> bool:
    t = text or ""
    return "DSML" in t or "｜｜" in t or "<|" in t


def _sanitize_dsml(text: str) -> str:
    """去掉 DeepSeek 偶发把工具调用写成 DSML 标记的噪音，只保留正常回答行。"""
    out = []
    for line in (text or "").splitlines():
        if "DSML" in line or "｜｜" in line:
            continue
        out.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


def _chat_stream(messages, tools=None, on_text=None):
    """流式 chat completion：累积 tool_calls；content 增量通过 on_text 回调。"""
    key = os.environ.get("CM_AI_KEY", "").strip()
    if not key:
        raise AiError("AI 未配置")
    payload = {"model": MODEL, "messages": messages,
               "max_tokens": MAX_TOKENS, "temperature": 0.6, "stream": True}
    if EFFORT in EFFORT_LEVELS:
        payload["reasoning_effort"] = EFFORT
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    req = urllib.request.Request(
        API_BASE + "/chat/completions", data=json.dumps(payload, ensure_ascii=False).encode(),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
        method="POST")
    calls, text_parts, tool_seen = [], [], False
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    d = json.loads(data)
                except ValueError:
                    continue
                delta = ((d.get("choices") or [{}])[0].get("delta") or {})
                chunk = delta.get("content")
                if chunk:
                    text_parts.append(chunk)
                    if on_text and not tool_seen:
                        visible = "".join(text_parts)
                        if not _has_dsml(visible):
                            on_text(visible)
                for tc in delta.get("tool_calls") or []:
                    tool_seen = True
                    idx = int(tc.get("index") or 0)
                    while len(calls) <= idx:
                        calls.append({"id": "", "type": "function",
                                      "function": {"name": "", "arguments": ""}})
                    c = calls[idx]
                    if tc.get("id"):
                        c["id"] = tc["id"]
                    fn = tc.get("function") or {}
                    if fn.get("name"):
                        c["function"]["name"] += fn["name"]
                    if fn.get("arguments"):
                        c["function"]["arguments"] += fn["arguments"]
    except urllib.error.HTTPError as e:
        raise AiError(f"上游 HTTP {e.code}")
    except Exception as e:  # noqa: BLE001
        raise AiError(f"上游流式请求失败：{e}")
    return {"content": "".join(text_parts), "tool_calls": calls or None}


def _music_search(type_, query: str):
    t = type_ if type_ in TYPE_LABEL else "song"
    q = str(query or "").strip()[:100]
    if not q:
        return []
    arr = {"song": "songs", "album": "albums", "artist": "artists", "playlist": "playlists"}[t]
    d = cm_ncm.search_types(q, types=[t], limit=3)
    out = []
    for x in (d.get(arr) or [])[:3]:
        if t == "song":
            out.append({"type": "song", "id": x.get("ncm_id"), "name": x.get("name") or "",
                        "sub": x.get("artists") or "", "pic": x.get("pic") or ""})
        elif t == "album":
            out.append({"type": "album", "id": x.get("id"), "name": x.get("name") or "",
                        "sub": x.get("artist") or "", "pic": x.get("pic") or ""})
        elif t == "artist":
            out.append({"type": "artist", "id": x.get("id"), "name": x.get("name") or "",
                        "sub": x.get("alias") or "", "pic": x.get("pic") or ""})
        else:
            out.append({"type": "playlist", "id": x.get("id"), "name": x.get("name") or "",
                        "sub": f"{int(x.get('trackCount') or 0)} 首", "pic": x.get("pic") or ""})
    return [x for x in out if x.get("id")]


def _attach_card(args, cards, hits=None, quotes=None):
    t = str(args.get("type") or "")
    if t not in TYPE_LABEL:
        return "类型必须是 song/album/artist/playlist"
    try:
        i = int(args.get("id"))
    except (TypeError, ValueError):
        return "id 无效"
    if i <= 0:
        return "id 无效"
    # 只认真实来源：本次 search_music 的结果，或用户引用的卡片；字段以来源为准，避免编造
    src = None
    for h in list(hits or []) + list(quotes or []):
        try:
            if h.get("type") == t and int(h.get("id")) == i:
                src = h
                break
        except (TypeError, ValueError):
            continue
    if not src:
        return "只能附加 search_music 返回的条目或用户引用的卡片"
    name = str(src.get("name") or "").strip()[:120]
    if not name:
        return "卡片缺少名称"
    if any(c["type"] == t and c["id"] == i for c in cards):
        return "卡片已附加"
    if any(c["type"] == t and (c.get("name") or "").strip() == name for c in cards):
        return "同名卡片已附加，同一部作品不要重复"
    if len(cards) >= 3:
        return "最多附加 3 张卡片"
    cards.append({"type": t, "id": i, "name": name,
                  "sub": str(src.get("sub") or "").strip()[:120],
                  "pic": str(src.get("pic") or "").strip()[:400]})
    return "已附加"


def _search(query: str):
    q = str(query or "").strip()[:200]
    if not q:
        return []
    d = _post("/tools/search", {"query": q, "max_results": 4}, timeout=30.0)
    out = []
    for x in (d.get("results") or [])[:4]:
        out.append({
            "title": str(x.get("title") or "")[:200],
            "url": str(x.get("url") or "")[:500],
            "summary": str(x.get("summary") or "")[:500],
            "date": str(x.get("date") or "")[:40],
        })
    return out


def _fetch(url: str) -> str:
    u = str(url or "").strip()[:1000]
    if not u.startswith("http"):
        return "URL 无效"
    d = _post("/tools/fetch", {"url": u}, timeout=30.0)
    return str(d.get("content") or "")[:6000]


def _fallback_cards(text, cards, hits):
    """模型漏调 attach_card 时的兜底：只附加回复中确实提到、且能唯一定位的条目。

    站内搜索会返回大量同名翻唱/同人专辑；同名条目若有多个版本，必须歌手也
    出现在回答里才附，否则宁可不附——错误卡片比没有卡片更糟。
    """
    if cards or not hits:
        return cards
    groups = {}
    for h in hits:
        name = (h.get("name") or "").strip()
        if name:
            groups.setdefault(name, []).append(h)
    out = list(cards)
    for name, group in groups.items():
        if name not in text:
            continue
        if len(group) == 1:
            pick = group[0]
        else:
            matched = [h for h in group
                       if (h.get("sub") or "").strip() and h["sub"].strip() in text]
            if len(matched) != 1:
                continue
            pick = matched[0]
        if not any(c["type"] == pick["type"] and c["id"] == pick["id"] for c in out):
            out.append(pick)
            if len(out) >= 3:
                break
    if len(out) > len(cards):
        log.info("卡片兜底：%s", "、".join(c["name"] for c in out))
    return out


def _plain_retry(messages, on_text=None) -> str:
    """模型把工具调用误写成正文 DSML 时，要求它直接给最终回答（禁用工具）。"""
    note = {"role": "system", "content":
            "上一轮输出了工具调用标记（DSML），用户看不到这些标记。请直接给出最终可读回答，"
            "不要输出 DSML、XML、工具调用过程或参数。"}
    msg = _chat_stream(list(messages) + [note], None, on_text)
    return _sanitize_dsml((msg.get("content") or "").strip())


def _answer_stream(question: str, card: str, uid: int, on_text=None, quote_atts=None,
                   image_url: str = "", scope: str = "chat"):
    """流式工具循环；返回 (最终回答, 附带的卡片列表)。"""
    quote_atts = quote_atts or []
    turn = user_turn(card, question, bool(image_url))
    history_turn = turn + ("\n（附带图片）" if image_url else "")
    messages = [{"role": "system", "content": SYSTEM}] + load_history(uid, scope) + \
               [user_message(card, question, image_url)]
    searches = fetches = 0
    cards = []
    music_hits = []          # search_music 的结果：模型偶尔会漏掉 attach_card，用于兜底
    for _ in range(MAX_ROUNDS):
        msg = _chat_stream(messages, TOOLS, on_text)
        calls = msg.get("tool_calls") or []
        if not calls:
            text = (msg.get("content") or "").strip()
            if text:
                if _has_dsml(text):
                    text = ""
                    if on_text:
                        on_text("")
                    try:
                        text = _plain_retry(messages, on_text)
                    except AiError:
                        text = ""
                    if not text:
                        raise AiError("模型返回了无效的工具标记")
                text = _sanitize_dsml(text)
                if text:
                    cards = _fallback_cards(text, cards, music_hits)
                    append_history(uid, "user", history_turn, scope)
                    append_history(uid, "assistant", text, scope)
                    return text, cards
            break
        # 工具轮可能先流出了中间文本：清空占位，等工具执行后的最终回答
        if (msg.get("content") or "").strip() and on_text:
            on_text("")
        messages.append({"role": "assistant", "content": msg.get("content") or None,
                         "tool_calls": calls})
        for tc in calls:
            fn = tc.get("function") or {}
            name = fn.get("name")
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except ValueError:
                args = {}
            if name == "search" and searches < MAX_SEARCH:
                searches += 1
                try:
                    content = json.dumps({"results": _search(args.get("query") or question)},
                                         ensure_ascii=False)
                except Exception as e:  # noqa: BLE001
                    content = f"搜索失败：{e}"
            elif name == "fetch" and fetches < MAX_FETCH:
                fetches += 1
                try:
                    content = _fetch(args.get("url") or "")
                except Exception as e:  # noqa: BLE001
                    content = f"抓取失败：{e}"
            elif name == "search_music":
                try:
                    hits = _music_search(args.get("type"), args.get("query"))
                    content = json.dumps({"results": hits}, ensure_ascii=False)
                    for h in hits:
                        if not any(x["type"] == h["type"] and x["id"] == h["id"]
                                   for x in music_hits):
                            music_hits.append(h)
                except Exception as e:  # noqa: BLE001
                    content = f"站内搜索失败：{e}"
            elif name == "attach_card":
                content = _attach_card(args, cards, music_hits, quote_atts)
            else:
                content = "本次请求的检索次数已用完，或工具不可用。"
            messages.append({"role": "tool", "tool_call_id": tc.get("id") or "",
                             "content": content})
    # 轮数用尽：不带工具再要一次最终回答（仍流式）
    msg = _chat_stream(messages, None, on_text)
    text = (msg.get("content") or "").strip()
    if not text:
        raise AiError("模型没有返回内容")
    cards = _fallback_cards(text, cards, music_hits)
    append_history(uid, "user", history_turn, scope)
    append_history(uid, "assistant", text, scope)
    return text, cards


def answer_player(uid: int, question: str, atts, reset: bool = False, on_text=None):
    """播放页「问AI」：复用 Chat 的回答/工具/卡片链路，但使用独立 player 上下文。"""
    if reset:
        clear_history(uid, "player")
    card = card_text(atts) if atts else ""
    with _sem:
        return _answer_stream(question, card, uid, on_text, atts, "", "player")


# ---------------------------------------------------------------- 消息侧

def card_text(atts) -> str:
    a = (atts or [{}])[0]
    if not a:
        return ""
    lines = [f"类型：{TYPE_LABEL.get(a.get('type'), a.get('type') or '')}",
             f"名称：{a.get('name') or ''}"]
    if a.get("sub"):
        lines.append(f"{SUB_LABEL.get(a.get('type'), '信息')}：{a['sub']}")
    if a.get("id"):
        lines.append(f"ID：{a['id']}")
    return "\n".join(lines)


def clean_question(text: str) -> str:
    t = re.sub(r"@\s*" + re.escape(BOT_NICKNAME), "", text or "")
    t = re.sub(r"@\s*" + re.escape(BOT_USERNAME), "", t)
    return t.strip()[:300]


def trim_answer(text: str, limit: int = ANSWER_LIMIT) -> str:
    t = re.sub(r"\n{3,}", "\n\n", (text or "").strip())
    if len(t) > limit:
        cut = t[:limit]
        for sep in ("\n", "。", "！", "？", "；"):
            i = cut.rfind(sep)
            if i > limit * 0.6:
                cut = cut[: i + 1]
                break
        t = cut.rstrip() + "…"
    return t


def should_reply(sender, mentions) -> bool:
    uid = bot_uid()
    return bool(uid and sender and sender.get("id") != uid and uid in (mentions or []))


def _send(text: str):
    u = bot_user()
    if not u:
        return
    text = trim_answer(text)
    if text:
        cm_chat.send(u, text, "", [], [])


def _reply(sender, question, atts, image=""):
    with _sem:
        t0 = time.time()
        mid = None
        try:
            q = clean_question(question)
            if is_clear_command(q):
                clear_history(sender["id"])
                _send("已清除我们之前的对话上下文。")
                return
            if not q and not atts and not image:
                _send("你想聊点什么？可以直接问我，也可以引用一张卡片再问。")
                return
            image_url = _image_data_url(image) if image else ""
            if image and not image_url:
                _send("这张图片读取失败了，换一张 JPG / PNG 图片再试试吧。")
                return
            card = card_text(atts) if atts else ""
            bot = bot_user()
            if not bot:
                return
            # 先落一条空消息（streaming=true）：客户端显示「正在思考…」，随后逐段 edit
            ph = cm_chat.send(bot, "", "", [], [], streaming=True)
            mid = ph["id"]
            last = [0.0]

            def push(text):
                now = time.time()
                if text and now - last[0] < 0.15:
                    return
                last[0] = now
                try:
                    cm_chat.edit(mid, text or "", [], streaming=True)
                except Exception:  # noqa: BLE001 单次增量失败不影响最终结果
                    pass

            ans, cards = _answer_stream(q or "", card, sender["id"], push, atts, image_url)
            cm_chat.edit(mid, trim_answer(ans), cm_chat.parse_atts(cards), streaming=False)
            log.info("AI 回答 uid=%s song=%s image=%s cards=%d 用时=%.1fs",
                     sender.get("id"), (atts[0] or {}).get("id") if atts else "-",
                     "yes" if image_url else "-", len(cards), time.time() - t0)
        except Exception as e:  # noqa: BLE001 任何失败都要给用户一个回复
            log.warning("AI 回答失败 uid=%s: %s", sender.get("id"), e)
            if mid:
                try:
                    cm_chat.edit(mid, "联网查询失败了，稍后再问我一次吧。", [], streaming=False)
                except Exception:  # noqa: BLE001
                    pass
            else:
                _send("联网查询失败了，稍后再问我一次吧。")


def spawn_reply(sender, question, atts, image=""):
    """在后台回答；同一用户串行处理，快速追问会排队而不是被静默丢弃。"""
    uid = bot_uid()
    if not uid or not sender or sender.get("id") == uid:
        return
    if not api_ready():
        _send("AI 助手还没接入模型，请联系管理员配置 DeepSeek。")
        return
    sid = sender["id"]
    now = time.time()
    with _lock:
        if sid in _pending:
            busy = True
            wait = 0.0
        else:
            busy = False
            wait = max(0.0, COOLDOWN - (now - _last.get(sid, 0)))
            _last[sid] = now + wait
            _pending.add(sid)
            if len(_last) > 4096:
                for k in [k for k, t in _last.items() if now - t > 3600]:
                    _last.pop(k, None)
    if busy:
        _send("我还在想上一个问题，稍等一下～")
        return

    def run():
        try:
            if wait:
                time.sleep(wait)
            _reply(sender, question, atts, image)
        finally:
            with _lock:
                _pending.discard(sid)

    threading.Thread(target=run, name="cm-ai-reply", daemon=True).start()
