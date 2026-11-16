"""用户反馈经 CurrentMusicAI 整理后发布至 CurrentMusicX Issues。"""
import html
import http.client
import json
import logging
import os
import re
import threading
import time
from contextlib import closing

import cm_ai
import cm_db

log = logging.getLogger("cm")
REPOSITORY = "bileizhen/CurrentMusicX"
ISSUE_TYPES = {"bug": ("[Bug]", "bug"), "feature": ("[Feature]", "enhancement")}
BUG_CONFIRMATION = (
    "### 提交前确认\n\n"
    "- [ ] 我已搜索现有 Issue，并检查所附信息不包含密码、Cookie、Token 等敏感内容。"
)
RETENTION = 7 * 86400
DAILY_LIMIT = 5
CONCURRENCY = 2
PRIVATE = re.compile(
    r"(?:https?://|www\.)[^\s<>\"，。！？；）]+"
    r"|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b"
    r"|(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)"
    r"|\b(?:gh[pousr]_|github_pat_|sk-)[A-Z0-9_-]{12,}"
    r"|(?:\bBearer\s+|(?:cookie|authorization|password|token|api[_ -]?key|music_[ua]|__csrf|密码|令牌)"
    r"\s*[:=：]\s*)[^\s，。；;]+",
    re.IGNORECASE,
)


class FeedbackError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def validate_id(request_id):
    if not isinstance(request_id, str) or not re.fullmatch(r"[0-9a-f]{32}", request_id):
        raise FeedbackError(400, "requestId 须为 32 位小写十六进制字符串")


def clean(text):
    text = re.sub(r"[\x00-\x08\x0b-\x1f\x7f\ud800-\udfff]", "", text.replace("\r\n", "\n").replace("\r", "\n"))
    text = PRIVATE.sub("【已隐藏】", text)
    return re.sub(r"#(?=\d)", "＃", text.replace("@", "＠")).strip()


def _receipt(row):
    result = {"requestId": row["request_id"], "status": row["status"]}
    number = row["issue_number"]
    if number:
        result.update(issueNumber=number, issueUrl=f"https://github.com/{REPOSITORY}/issues/{number}")
    return result


def status(uid, request_id):
    validate_id(request_id)
    with closing(cm_db.connect()) as conn:
        row = conn.execute(
            "SELECT * FROM feedback_receipts WHERE user_id=? AND request_id=? AND created_at>=?",
            (uid, request_id, time.time() - RETENTION),
        ).fetchone()
    if row is None:
        raise FeedbackError(404, "未找到该反馈")
    return _receipt(row)


def submit(uid, body):
    if not isinstance(body, dict):
        raise FeedbackError(400, "请求体须为 JSON 对象")
    request_id = body.get("requestId")
    validate_id(request_id)
    if body.get("public") is not True:
        raise FeedbackError(400, "请确认反馈将作为公开 Issue 发布")
    text = body.get("content")
    if not isinstance(text, str) or not 8 <= len(text.strip()) <= 2000:
        raise FeedbackError(400, "反馈内容须为 8 至 2000 字")
    text = clean(text)
    if len(text.replace("【已隐藏】", "").strip()) < 8:
        raise FeedbackError(400, "请填写具体的问题或建议")
    token = os.environ.get("CM_FEEDBACK_GITHUB_TOKEN", "").strip()
    now = int(time.time())
    with closing(cm_db.connect()) as conn, conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("DELETE FROM feedback_receipts WHERE created_at<?", (now - RETENTION,))
        row = conn.execute("SELECT * FROM feedback_receipts WHERE user_id=? AND request_id=?",
                           (uid, request_id)).fetchone()
        if row:
            return _receipt(row)
        if not token:
            raise FeedbackError(503, "意见反馈暂未启用")
        active, owned = conn.execute(
            "SELECT COUNT(*), COUNT(CASE WHEN user_id=? THEN 1 END) FROM feedback_receipts"
            " WHERE status IN ('processing','publishing')", (uid,),
        ).fetchone()
        recent = conn.execute(
            "SELECT COUNT(*) FROM feedback_receipts WHERE user_id=? AND created_at>=?",
            (uid, now - 86400),
        ).fetchone()[0]
        if owned or recent >= DAILY_LIMIT:
            raise FeedbackError(429, "反馈提交过于频繁，请稍后再试")
        if active >= CONCURRENCY:
            raise FeedbackError(503, "反馈通道繁忙，请稍后再试")
        conn.execute(
            "INSERT INTO feedback_receipts(user_id,request_id,created_at,status) VALUES(?,?,?,'processing')",
            (uid, request_id, now),
        )
    try:
        threading.Thread(target=_run, args=(uid, request_id, text, token),
                         name="cm-feedback", daemon=True).start()
    except RuntimeError:
        _set_status(uid, request_id, "failed")
        return {"requestId": request_id, "status": "failed"}
    return {"requestId": request_id, "status": "processing"}


def _set_status(uid, request_id, state, number=None):
    with closing(cm_db.connect()) as conn, conn:
        conn.execute(
            "UPDATE feedback_receipts SET status=?,issue_number=? WHERE user_id=? AND request_id=?",
            (state, number, uid, request_id),
        )


def recover():
    """重启后终结上一次进程的任务，避免再次发布结果未确认的 Issue。"""
    with closing(cm_db.connect()) as conn, conn:
        conn.execute("UPDATE feedback_receipts SET status='failed' WHERE status='processing'")
        conn.execute("UPDATE feedback_receipts SET status='unconfirmed' WHERE status='publishing'")


def _safe_body(text):
    return html.escape(text, quote=False).replace("[", "&#91;").replace("]", "&#93;")


def _template_issue(kind, title, fields):
    prefix, label = ISSUE_TYPES[kind]
    title = re.sub(r"^(?:\[(?:bug|feature)\]\s*)+", "", clean(title), flags=re.IGNORECASE)
    title = f"{prefix} {' '.join(title.split())}"[:120]
    body = []
    for key, heading, required in cm_ai.FEEDBACK_SECTIONS[kind]:
        value = clean(fields.get(key, ""))[:2000]
        if key in cm_ai.FEEDBACK_CHOICES and value not in cm_ai.FEEDBACK_CHOICES[key]:
            value = "其他" if key == "module" else ""
        if not value:
            value = "不清楚" if required else "_No response_"
        # 保证反馈里的标题和代码围栏不会干扰模板结构。
        escaped = re.sub(r"(?m)^([ \t]{0,3})(#|`(?=``)|~(?=~~))",
                         lambda match: f"{match[1]}&#{ord(match[2])};", _safe_body(value))
        body.append(f"### {heading}\n\n{escaped}")
    if kind == "bug":
        body.append(BUG_CONFIRMATION)
    body.append("### 来源\n\n由 CurrentMusicAI 整理")
    return {"title": title, "body": "\n\n".join(body), "labels": [label]}


def _create_issue(token, issue):
    payload = json.dumps(issue, ensure_ascii=False).encode()
    with closing(http.client.HTTPSConnection("api.github.com", timeout=15)) as conn:
        conn.request("POST", f"/repos/{REPOSITORY}/issues", body=payload, headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "CurrentMusic-Feedback",
            "X-GitHub-Api-Version": "2022-11-28",
        })
        response = conn.getresponse()
        if response.status == 201:
            number = json.load(response)["number"]
            if type(number) is int and number > 0:
                return "published", number
        else:
            log.warning("反馈 Issue 创建返回 GitHub HTTP %d", response.status)
            if 400 <= response.status < 500 and response.status != 408:
                return "failed", None
    return "unconfirmed", None


def _run(uid, request_id, text, token):
    state = "failed"
    number = None
    try:
        try:
            formatted = cm_ai.format_feedback(text)
            issue = _template_issue(*formatted) if formatted is not None else None
        except cm_ai.AiError:
            issue = {
                "title": " ".join(text.splitlines()[0].split())[:120],
                "body": _safe_body(text) + "\n\n---\n由 CurrentMusic 用户提交的原始反馈",
            }
        if issue:
            _set_status(uid, request_id, "publishing")
            state = "unconfirmed"
            state, number = _create_issue(token, issue)
        else:
            state = "rejected"
    except Exception as exc:
        log.warning("用户反馈处理失败（%s）", type(exc).__name__)
    _set_status(uid, request_id, state, number)
