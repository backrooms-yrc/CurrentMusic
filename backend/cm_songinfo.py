"""Public song metadata contracts; upstream file metadata never proves playability."""
import math

import cm_ncm


QUALITY_LEVELS = (
    ("l", "standard", "标准"), ("m", "higher", "较高"),
    ("h", "exhigh", "极高"), ("sq", "lossless", "无损"),
    ("hr", "hires", "Hi-Res"), ("je", "jyeffect", "高清臻音"),
    ("db", "dolby", "杜比全景声"), ("vi", "vivid", "臻音全景声"),
    ("jm", "jymaster", "超清母带"), ("sk", "sky", "沉浸环绕声"),
)


def _number(value):
    if isinstance(value, bool):
        return 0
    try:
        n = float(value)
        return int(n) if math.isfinite(n) and n >= 0 else 0
    except (TypeError, ValueError, OverflowError):
        return 0


def _fetch(path, sid, real_ip):
    d = cm_ncm.call(path, {"id": sid}, real_ip=real_ip, timeout=10, retries=0)
    if not isinstance(d, dict) or d.get("code", 200) != 200 or d.get("success") is False:
        raise cm_ncm.NcmError("歌曲资料暂时不可用，请稍后重试")
    return d


def qualities(sid, real_ip):
    d = _fetch("/song/music/detail", sid, real_ip).get("data")
    if not isinstance(d, dict):
        raise cm_ncm.NcmError("音质资料格式异常，请稍后重试")
    rows = []
    for key, level, label in QUALITY_LEVELS:
        v = d.get(key)
        if not isinstance(v, dict) or not any(_number(v.get(k)) for k in ("br", "size", "sr")):
            continue
        row = {"level": level, "label": label,
               **{k: _number(v.get(k)) for k in ("br", "size", "sr")}}
        if level == "sky":
            variants = d.get("sks") if isinstance(d.get("sks"), list) else []
            row["variants"] = [
                {"immerseType": x["it"], **{k: _number(x.get(k)) for k in ("br", "size", "sr")}}
                for x in variants if isinstance(x, dict) and
                x.get("it") in ("c512", "ste2", "aac2", "c51", "ste", "aac")
            ]
        rows.append(row)
    return {"id": sid, "qualities": rows, "playability": "unknown"}


def chorus(sid, real_ip):
    d = _fetch("/song/chorus", sid, real_ip)
    raw = d.get("chorus") if isinstance(d.get("chorus"), list) else d.get("data")
    if not isinstance(raw, list):
        raise cm_ncm.NcmError("副歌资料格式异常，请稍后重试")
    segments = set()
    for v in raw:
        if not isinstance(v, dict) or ("id" in v and _number(v["id"]) != sid):
            continue
        start, end = _number(v.get("startTime")), _number(v.get("endTime"))
        # Missing/invalid starts must not become a valid jump to zero.
        if v.get("startTime") is None or isinstance(v.get("startTime"), bool):
            continue
        try:
            valid_start = math.isfinite(float(v["startTime"])) and float(v["startTime"]) >= 0
        except (TypeError, ValueError, OverflowError):
            valid_start = False
        if valid_start and end > start:
            segments.add((start, end))
    return {"id": sid, "segments": [{"startMs": a, "endMs": b} for a, b in sorted(segments)]}


def versions(sid, real_ip):
    d = _fetch("/song/copyright/rcmd", sid, real_ip).get("data")
    if not isinstance(d, dict):
        raise cm_ncm.NcmError("其他版本资料格式异常，请稍后重试")
    # originSong is the requested original; the actual recommendation lives in rcmd.
    raw = d.get("rcmd")
    raw = raw if isinstance(raw, list) else [raw]
    seen, songs = {sid}, []
    for v in raw:
        if not isinstance(v, dict):
            continue
        ncm_id = _number(v.get("id"))
        if not ncm_id or ncm_id in seen:
            continue
        seen.add(ncm_id)
        song = cm_ncm._norm_song(v)
        song["ncm_id"] = ncm_id
        songs.append(song)
    return {"id": sid, "songs": songs, "playability": "unknown"}
