#!/usr/bin/env python3
"""Publish a small public status snapshot from Gatus v5's SQLite store."""
import argparse
from contextlib import closing
from datetime import datetime, timedelta, timezone
from email.utils import formatdate
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import xml.etree.ElementTree as ET

TZ = timezone(timedelta(hours=8))
DAYS = 30


def timestamp(value):
    return int(datetime.fromisoformat(value.split(" +0000 UTC")[0]).replace(tzinfo=timezone.utc).timestamp())


def snapshot(db, now):
    today = datetime.fromtimestamp(now, TZ).date()
    first = today - timedelta(days=DAYS - 1)
    start = int(datetime.combine(first, datetime.min.time(), TZ).timestamp())
    endpoints = {}
    for key, name, group, success, checked_at in db.execute("""
        SELECT endpoints.endpoint_id, endpoint_name, endpoint_group, r.success, r.timestamp
        FROM endpoints
        LEFT JOIN endpoint_results r ON r.endpoint_result_id = (
            SELECT endpoint_result_id FROM endpoint_results
            WHERE endpoint_id = endpoints.endpoint_id ORDER BY endpoint_result_id DESC LIMIT 1
        )
        ORDER BY endpoint_group, endpoint_name
    """):
        endpoints[key] = {
            "key": key, "name": name.rsplit("（127.0.0.1:", 1)[0].rsplit("（:", 1)[0],
            "group": group, "up": bool(success) if checked_at else None,
            "checkedAt": timestamp(checked_at) if checked_at else None, "days": {},
        }
    for key, day, count, successful in db.execute("""
        SELECT endpoint_id, date(hour_unix_timestamp,'unixepoch','+8 hours'),
               sum(total_executions), sum(successful_executions)
        FROM endpoint_uptimes JOIN endpoints USING(endpoint_id)
        WHERE hour_unix_timestamp >= ?
        GROUP BY endpoint_id, 2 ORDER BY 2
    """, (start,)):
        endpoints[key]["days"][day] = [count, successful]

    open_incidents = {}
    incidents = []
    for key, state, at in db.execute("""
        SELECT endpoint_id, event_type, event_timestamp FROM endpoint_events
        JOIN endpoints USING(endpoint_id)
        WHERE event_type IN ('HEALTHY','UNHEALTHY') ORDER BY event_timestamp, endpoint_event_id
    """):
        when = timestamp(at)
        if state == "UNHEALTHY":
            open_incidents.setdefault(key, when)
        elif key in open_incidents:
            began = open_incidents.pop(key)
            if when >= start:
                incidents.append({"key": key, "startedAt": began, "endedAt": when})
    incidents.extend({"key": key, "startedAt": began, "endedAt": None}
                     for key, began in open_incidents.items() if endpoints[key]["up"] is False)
    incidents.sort(key=lambda row: row["startedAt"], reverse=True)
    return {"updatedAt": now, "from": first.isoformat(), "to": today.isoformat(),
            "services": list(endpoints.values()), "incidents": incidents}



def feed(data, page_url):
    rss = ET.Element("rss", version="2.0")
    channel = ET.SubElement(rss, "channel")
    for tag, text in (("title", "CurrentMusic 服务状态"), ("link", page_url),
                      ("description", "CurrentMusic 服务异常与恢复通知"), ("language", "zh-CN")):
        ET.SubElement(channel, tag).text = text
    names = {entry["key"]: entry["name"] for entry in data["services"]}
    changes = []
    for incident in data["incidents"]:
        changes.append((incident["startedAt"], incident["key"], "异常", "started"))
        if incident["endedAt"]:
            changes.append((incident["endedAt"], incident["key"], "恢复", "resolved"))
    for at, key, label, state in sorted(changes, reverse=True)[:80]:
        item = ET.SubElement(channel, "item")
        ET.SubElement(item, "title").text = f"{names[key]} · {label}"
        ET.SubElement(item, "link").text = page_url
        ET.SubElement(item, "pubDate").text = formatdate(at, usegmt=True)
        ET.SubElement(item, "guid", isPermaLink="false").text = f"{page_url}#{key}-{at}-{state}"
    return ET.tostring(rss, encoding="unicode", xml_declaration=True)


def publish(output, content):
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output.parent, delete=False) as fp:
        tmp = Path(fp.name)
        try:
            fp.write(content)
            fp.close()
            tmp.chmod(0o644)
            os.replace(tmp, output)
        finally:
            tmp.unlink(missing_ok=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=Path("/opt/gatus/data/gatus.db"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--url", default="https://music.20110208.xyz/status/")
    args = parser.parse_args()
    with closing(sqlite3.connect(args.db.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("BEGIN")
        data = snapshot(db, int(datetime.now(timezone.utc).timestamp()))
    publish(args.output, json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    publish(args.output.with_name("events.xml"), feed(data, args.url))


if __name__ == "__main__":
    main()
