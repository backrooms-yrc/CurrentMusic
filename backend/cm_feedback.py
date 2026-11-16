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


def _create_issue(token, title, body):
    payload = json.dumps({"title": title, "body": body}, ensure_ascii=False).encode()
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
            title, body = cm_ai.format_feedback(text)
            source = "由 CurrentMusicAI 整理"
        except cm_ai.AiError:
            title, body = text.splitlines()[0], text
            source = "由 CurrentMusic 用户提交的原始反馈"
        title = " ".join(clean(title).split())[:120]
        body = clean(body)[:6000]
        if title and body:
            _set_status(uid, request_id, "publishing")
            state = "unconfirmed"
            safe_body = html.escape(body, quote=False).replace("[", "&#91;").replace("]", "&#93;")
            state, number = _create_issue(token, title, safe_body + "\n\n---\n" + source)
        else:
            state = "rejected"
    except Exception as exc:
        log.warning("用户反馈处理失败（%s）", type(exc).__name__)
    _set_status(uid, request_id, state, number)
