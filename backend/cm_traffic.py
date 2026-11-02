"""nginx 访问日志 → 站点出站流量统计（管理员控制台「流量」卡片的数据源）。

设计要点：
· 只读 combined 格式日志（宝塔/nginx 通用），一次线性扫描聚出：按小时(48h)、
  按天(35d)、今日/本月总量、近 5 分钟实时速率、今日 Top 路径；
· 结果按 (路径, mtime, size) 缓存 20 秒：管理页 30 秒轮询一次，日志 74MB
  全量扫约 1~2 秒，不能每次都重扫；
· 日志路径由部署方通过 CM_TRAFFIC_LOG 指定（systemd drop-in），开源部署
  不配置该环境变量时接口返回 available=false，控制台显示配置提示。

计数口径：状态 2xx/3xx 的 body 字节数（与 IDC 计费的出站量最接近的可用近似，
不含响应头与连接开销；4xx/5xx 不计，避免扫描器刷错误页污染统计）。
"""
from __future__ import annotations

import os
import re
import threading
import time

LINE_RE = re.compile(
    r'^\S+ \S+ \S+ \[(\d{2})/([A-Za-z]{3})/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})\] '
    r'"(\S+) (\S+)[^"]*" (\d{3}) (\d+|-)'
)
MONTHS = {m: i + 1 for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}
# Top 路径按家族折叠：否则 80+ 个头像文件会霸榜，掩盖真正的消耗结构
_FAMILIES = ("avatar", "decor", "cast", "download", "share", "image")

_lock = threading.Lock()
_cache = {"key": None, "at": 0.0, "data": None}


def _epoch(m) -> int:
    import calendar
    yy, mo, dd = int(m.group(3)), MONTHS.get(m.group(2), 1), int(m.group(1))
    ts = calendar.timegm((yy, mo, dd, int(m.group(4)), int(m.group(5)), int(m.group(6)), 0, 0, 0))
    off = int(m.group(8)) * 3600 + int(m.group(9)) * 60
    return ts + (-off if m.group(7) == "+" else off)


def _family(uri: str) -> str:
    parts = uri.split("?")[0].split("/")
    # ["", "cm", "avatar", "33.jpg"] 共 4 段即代表「家族下有具体文件」→ 折叠
    if len(parts) >= 4 and parts[1] == "cm" and parts[2] in _FAMILIES:
        return "/cm/" + parts[2] + "/*"
    return uri.split("?")[0]


def _aggregate(path: str) -> dict:
    hourly, daily = {}, {}
    minute = {}
    today_key = None
    top = {}
    now = int(time.time())
    day_now = time.strftime("%Y-%m-%d", time.localtime(now))

    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            m = LINE_RE.match(line)
            if not m:
                continue
            status = int(m.group(12))
            if not (200 <= status < 400):
                continue
            n = 0 if m.group(13) == "-" else int(m.group(13))
            ts = _epoch(m)
            lt = time.localtime(ts)
            hkey = time.strftime("%Y-%m-%d %H:00", lt)
            dkey = time.strftime("%Y-%m-%d", lt)
            if hkey not in hourly:
                hourly[hkey] = [0, ts // 3600 * 3600]
            hourly[hkey][0] += n
            daily[dkey] = daily.get(dkey, 0) + n
            minute[ts // 60] = minute.get(ts // 60, 0) + n
            if dkey == day_now:
                fam = _family(m.group(11))
                t = top.get(fam)
                top[fam] = (t[0] + n, t[1] + 1) if t else (n, 1)

    hour_start = (now - 47 * 3600) // 3600 * 3600
    day_start_epoch = now - 34 * 86400
    hours = sorted(hourly.items())
    hour_series = [{"t": b, "bytes": v} for k, (v, b) in hours if b >= hour_start]
    day_series = []
    for k, v in sorted(daily.items()):
        t = int(time.mktime(time.strptime(k, "%Y-%m-%d")))
        if t >= day_start_epoch:
            day_series.append({"t": t, "bytes": v})

    rate = sum(v for k, v in minute.items() if k * 60 >= now - 300) / 300.0
    month_prefix = time.strftime("%Y-%m", time.localtime(now))
    return {
        "generatedAt": now,
        "today": daily.get(day_now, 0),
        "month": sum(v for k, v in daily.items() if k.startswith(month_prefix)),
        "rate5m": round(rate, 1),
        "hourly": hour_series,
        "daily": day_series,
        "top": [{"path": k, "bytes": v[0], "req": v[1]}
                for k, v in sorted(top.items(), key=lambda kv: -kv[1][0])[:8]],
    }


def snapshot(log_path: str) -> dict:
    """聚合结果（带 20s 缓存）；路径为空/不可读时返回 available=false。"""
    if not log_path or not os.path.isfile(log_path):
        return {"available": False}
    try:
        st = os.stat(log_path)
        key = (log_path, st.st_mtime_ns, st.st_size)
    except OSError:
        return {"available": False}
    with _lock:
        if _cache["key"] == key and time.time() - _cache["at"] < 20:
            return _cache["data"]
    try:
        data = _aggregate(log_path)
    except OSError:
        return {"available": False}
    data["available"] = True
    with _lock:
        _cache.update(key=key, at=time.time(), data=data)
    return data
