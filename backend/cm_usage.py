"""Aggregate API requests and song traffic without retaining request details."""
from collections import defaultdict
from contextlib import closing
from datetime import datetime, timedelta, timezone
import re
import threading
import time

import cm_db

SCHEMA = """
CREATE TABLE IF NOT EXISTS usage_hourly (
    hour INTEGER PRIMARY KEY,
    api_calls INTEGER NOT NULL DEFAULT 0,
    served_bytes INTEGER NOT NULL DEFAULT 0,
    direct_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS usage_started (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    started_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_audio_receipts (
    session TEXT PRIMARY KEY,
    bytes INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_audio_receipts_age ON usage_audio_receipts(updated_at);
"""
TZ = timezone(timedelta(hours=8))
HOUR = 3600
RECEIPT_TTL = 2 * 86400
MAX_AUDIO_BYTES = 1024 ** 3
IGNORED_API_ROOTS = {"", "avatar", "decor", "developer", "station", "usage"}
IGNORED_API_PATHS = {"/health", "/network/probe", "/ncm/song/url/health", "/admin/traffic"}
_pending = defaultdict(lambda: [0, 0])
_lock = threading.Lock()
_flush_lock = threading.Lock()
_next_cleanup = 0


def _hour(now):
    return int(now) // HOUR * HOUR


def note_api(path):
    if path.split("/", 2)[1] not in IGNORED_API_ROOTS and path not in IGNORED_API_PATHS:
        with _lock:
            _pending[_hour(time.time())][0] += 1


def write_audio(handler, chunk):
    handler.wfile.write(chunk)
    with _lock:
        _pending[_hour(time.time())][1] += len(chunk)


def flush():
    global _next_cleanup
    with _flush_lock:
        with _lock:
            batch = dict(_pending)
            _pending.clear()
        now = int(time.time())
        if not batch and now < _next_cleanup:
            return
        try:
            with closing(cm_db.connect()) as conn, conn:
                conn.executemany("""
                    INSERT INTO usage_hourly(hour, api_calls, served_bytes) VALUES(?, ?, ?)
                    ON CONFLICT(hour) DO UPDATE SET api_calls=api_calls+excluded.api_calls,
                        served_bytes=served_bytes+excluded.served_bytes
                    """, ((hour, *values) for hour, values in batch.items()))
                if now >= _next_cleanup:
                    conn.execute("DELETE FROM usage_audio_receipts WHERE updated_at < ?", (now - RECEIPT_TTL,))
            if now >= _next_cleanup:
                _next_cleanup = now + HOUR
        except Exception:
            with _lock:
                for hour, (calls, served) in batch.items():
                    _pending[hour][0] += calls
                    _pending[hour][1] += served
            raise


def report_audio(body, now=None):
    """Apply the increase of a cumulative report once, including concurrent retries."""
    if not isinstance(body, dict) or set(body) != {"session", "bytes"}:
        raise ValueError("无效的歌曲流量上报")
    session, size = body["session"], body["bytes"]
    if not isinstance(session, str) or not re.fullmatch(r"[a-f0-9]{32}", session):
        raise ValueError("无效的流量会话")
    if type(size) is not int or not 0 < size <= MAX_AUDIO_BYTES:
        raise ValueError("歌曲流量超出范围")
    now = int(time.time() if now is None else now)
    with closing(cm_db.connect()) as conn, conn:
        conn.execute("BEGIN IMMEDIATE")
        previous = conn.execute("SELECT bytes FROM usage_audio_receipts WHERE session=?", (session,)).fetchone()
        if previous and previous[0] >= size:
            return
        conn.execute("""
            INSERT INTO usage_audio_receipts(session, bytes, updated_at) VALUES(?, ?, ?)
            ON CONFLICT(session) DO UPDATE SET bytes=excluded.bytes, updated_at=excluded.updated_at
            """, (session, size, now))
        conn.execute("""
            INSERT INTO usage_hourly(hour, direct_bytes) VALUES(?, ?)
            ON CONFLICT(hour) DO UPDATE SET direct_bytes=direct_bytes+excluded.direct_bytes
            """, (_hour(now), size - (previous[0] if previous else 0)))


def snapshot(now=None):
    now = int(time.time() if now is None else now)
    local = datetime.fromtimestamp(now, TZ)
    today = local.replace(hour=0, minute=0, second=0, microsecond=0)
    year = today.replace(month=1, day=1)
    month = today.replace(day=1)
    week = today - timedelta(days=today.weekday())
    current_hour = _hour(now)
    earliest_hour = int(min(year, week).timestamp())
    with _flush_lock:
        with _lock:
            pending = {hour: tuple(values) for hour, values in _pending.items()}
        with closing(cm_db.connect()) as conn:
            since = conn.execute("SELECT started_at FROM usage_started WHERE id=1").fetchone()[0]
            rows = {r[0]: list(r[1:]) for r in conn.execute(
                "SELECT hour, api_calls, served_bytes, direct_bytes FROM usage_hourly WHERE hour BETWEEN ? AND ?",
                (earliest_hour, current_hour))}
        for hour, (calls, served) in pending.items():
            if earliest_hour <= hour <= current_hour:
                row = rows.setdefault(hour, [0, 0, 0])
                row[0] += calls
                row[1] += served

    def metrics(values):
        return dict(zip(("apiCalls", "servedBytes", "directEstimatedBytes"), values))

    def period(start, grain):
        buckets = {}
        cursor = start
        start_ts = int(start.timestamp())
        while cursor <= local:
            buckets[int(cursor.timestamp())] = [0, 0, 0]
            if grain == "month":
                cursor = (cursor.replace(day=28) + timedelta(days=4)).replace(day=1)
            else:
                cursor += timedelta(hours=1) if grain == "hour" else timedelta(days=1)
        for hour, values in rows.items():
            if hour < start_ts:
                continue
            key = datetime.fromtimestamp(hour, TZ)
            if grain != "hour":
                key = key.replace(hour=0, day=1 if grain == "month" else key.day)
            for index, value in enumerate(values):
                buckets[int(key.timestamp())][index] += value
        return {
            "start": start_ts,
            "total": metrics(map(sum, zip(*buckets.values()))),
            "series": [{"t": ts, **metrics(values)} for ts, values in buckets.items()],
        }

    return {"generatedAt": now, "since": since, "timezone": "Asia/Shanghai", "periods": {
        "year": period(year, "month"), "month": period(month, "day"),
        "week": period(week, "day"), "day": period(today, "hour"),
    }}
