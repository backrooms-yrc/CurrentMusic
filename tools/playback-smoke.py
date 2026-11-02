#!/usr/bin/env python3
"""播放抗卡顿（服务端）端到端冒烟测试（v1.28.23）。

用**临时库**起一个实例再跑，避免污染线上数据：

    CM_DB=/tmp/play.db CM_PORT=3097 python3 backend/cm_server.py &
    CM_DB=/tmp/play.db python3 tools/playback-smoke.py http://127.0.0.1:3097

覆盖：
  ① 播放地址解析的新契约（host / fromCache / resolvedMs / expireAt / 10 分钟缓存）；
  ② `maxBr` 码率上限（只降不升、按档位边界向下取整）；
  ③ `alts` 候选边缘 与 `refresh` 卡顿换线（毫秒级、且真的换了 host）；
  ④ 卡顿上报 `/ncm/song/url/feedback`（合法接受、非法拒绝）；
  ⑤ 限速键按真实客户端分桶（`X-Real-IP` / XFF 末跳），不再全站共用 127.0.0.1 一个桶。

需要真实 NCM 上游（本机 127.0.0.1:3001）：取不到地址的用例会标 SKIP 而不是失败，
这样离线环境也不会误报。退出码 0 = 全部通过（SKIP 不算失败）。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3010").rstrip("/")
API = BASE + "/cm"

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))
import cm_ncm_gateway  # noqa: E402
import cm_stream  # noqa: E402

PASSED, FAILED, SKIPPED = [], [], []


def check(name, cond, detail=""):
    (PASSED if cond else FAILED).append(name)
    print(("  ✓ " if cond else "  ✗ ") + name + (f"   {detail}" if detail and not cond else ""))


def skip(name, why):
    SKIPPED.append(name)
    print(f"  – SKIP {name}（{why}）")


def req(method, path, body=None, headers=None):
    url = path if path.startswith("http") else API + path
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    t0 = time.time()
    try:
        with urllib.request.urlopen(r, timeout=40) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {}), time.time() - t0
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}"), time.time() - t0
        except Exception:  # noqa: BLE001
            return e.code, {}, time.time() - t0


def detect_api():
    global API
    for prefix in ("/cm", ""):
        st, _, _ = req("GET", BASE + prefix + "/health")
        if st == 200:
            API = BASE + prefix
            return True
    return False


# 稳定的老歌（可播且上游缓存热点）：用于契约类断言
SONG = 347230


def main():
    if not detect_api():
        print(f"!! 连不上后端 {BASE}")
        return 1
    print(f"目标 {API}\n")

    # ---------- ① 解析契约与缓存 ----------
    print("[1] 播放地址解析契约")
    st, d, dt = req("GET", f"/ncm/song/url?id={SONG}&level=exhigh")
    if st != 200 or not d.get("url"):
        skip("解析契约", f"上游未返回地址（HTTP {st}）")
        first_host = ""
    else:
        first_host = d.get("host") or ""
        check("返回 url/host/level/br/type", all(k in d for k in ("url", "host", "level", "br", "type")))
        check("host 是网易云边缘", cm_stream.is_edge_host(first_host), first_host)
        check("新增诊断字段 fromCache/resolvedMs/expireAt",
              all(k in d for k in ("fromCache", "resolvedMs", "expireAt")))
        st2, d2, dt2 = req("GET", f"/ncm/song/url?id={SONG}&level=exhigh")
        check("二次解析命中缓存且与首次同一 host", d2.get("fromCache") is True and d2.get("host") == first_host)
        check("缓存命中 <300ms", dt2 < 0.3, f"{dt2*1000:.0f}ms")
        check("缓存地址一致", d2.get("url") == d.get("url"))

    # ---------- ② maxBr ----------
    print("\n[2] maxBr 码率上限（只降不升）")
    cap = cm_stream.NOMINAL_BR["standard"]
    st, d, _ = req("GET", f"/ncm/song/url?id={SONG}&level=auto&maxBr={cap}")
    if st != 200 or not d.get("url"):
        skip("maxBr 上限", f"上游未返回地址（HTTP {st}）")
    else:
        lv = d.get("level") or ""
        check(f"maxBr={cap} 时档位不高于标准档", lv in ("standard",),
              f"实际 {lv}")
        check("maxBr 生效时 br 不超过上限（留 10% 档位漂移）",
              (d.get("br") or 0) <= cap * 1.1, f"br={d.get('br')}")

    cap2 = cm_stream.NOMINAL_BR["lossless"]
    st, d, _ = req("GET", f"/ncm/song/url?id={SONG}&level=auto&maxBr={cap2}")
    if st != 200 or not d.get("url"):
        skip("maxBr 无损档", f"上游未返回地址（HTTP {st}）")
    else:
        lv = d.get("level") or ""
        check(f"maxBr={cap2} 时不会给到母带/臻音/全景声", lv in ("lossless", "exhigh", "standard"),
              f"实际 {lv}")

    # 量化：任意整数都应落到档位边界，缓存键不会被撑爆
    check("maxBr 向下量化到档位边界",
          cm_stream.quantize_max_br(cap2 - 1) < cap2 and cm_stream.quantize_max_br(cap2) == cap2)

    # ---------- ③ alts / refresh 换线 ----------
    print("\n[3] 候选边缘与卡顿换线")
    hosts = []
    for _ in range(24):        # 后台取证是异步的，给它最多 12 秒
        time.sleep(0.5)
        st, d, _ = req("GET", f"/ncm/song/url?id={SONG}&level=auto&alts=1")
        hosts = d.get("hosts") or []
        if len(hosts) >= 2:
            break
    if len(hosts) < 2:
        skip("refresh 换线", f"该对象暂未找到可互换边缘（hosts={hosts}）")
    else:
        check("alts 给出的边缘都在已知族内", all(cm_stream.is_edge_host(h) for h in hosts), str(hosts))
        check("alts 含当前 host", first_host in hosts or d.get("host") in hosts, str(hosts))
        seen = []
        ok_fast = True
        for _ in range(2):
            st, d, dt = req("GET", f"/ncm/song/url?id={SONG}&level=auto&refresh=1")
            seen.append(d.get("host"))
            if dt > 0.5 or d.get("switched") is not True:
                ok_fast = False
        check("refresh 换到另一条线且毫秒级返回", ok_fast, f"{seen} {dt*1000:.0f}ms")
        check("连续 refresh 逐条轮换（不重复卡在同一条线）", seen[0] != seen[1], str(seen))

    # ---------- ④ 卡顿上报 ----------
    print("\n[4] 卡顿上报与边缘健康度")
    target = (hosts[0] if hosts else "") or first_host or "m7.music.126.net"
    st, d, _ = req("POST", "/ncm/song/url/feedback",
                   {"id": SONG, "host": target, "event": "stall", "level": "lossless"})
    check("合法 stall 上报被接受", st == 200 and d.get("ok") is True, f"HTTP {st} {d}")
    st, h, _ = req("GET", "/ncm/song/url/health")
    check("health 可读且含 policy/edgeHosts", st == 200 and "policy" in h and "edgeHosts" in h)
    check("被投诉的边缘进入观察期", bool((h.get("edgeHosts") or {}).get(target, {}).get("bad")),
          str((h.get("edgeHosts") or {}).get(target)))
    st, d, _ = req("POST", "/ncm/song/url/feedback", {"id": SONG, "host": target, "event": "ok"})
    check("合法 ok 上报被接受", st == 200 and d.get("ok") is True, f"HTTP {st} {d}")
    st, _, _ = req("POST", "/ncm/song/url/feedback", {"host": "evil.com", "event": "stall"})
    check("非网易云域名被拒（400）", st == 400, f"HTTP {st}")
    st, _, _ = req("POST", "/ncm/song/url/feedback", {"host": "m7.music.126.net", "event": "hack"})
    check("非法 event 被拒（400）", st == 400, f"HTTP {st}")

    # ---------- ⑤ 限速键 ----------
    print("\n[5] 限速按真实客户端分桶（此前全站共用 127.0.0.1 一个桶）")

    class _H:
        def __init__(self, hdrs, addr=("127.0.0.1", 1)):
            self.headers = hdrs
            self.client_address = addr

    check("优先取 X-Real-IP（nginx 覆盖写入，不可伪造）",
          cm_ncm_gateway.rate_key(_H({"X-Real-IP": "1.2.3.4", "X-Forwarded-For": "9.9.9.9"})) == "1.2.3.4")
    check("无 X-Real-IP 时取 XFF 末跳（真实对端），而不是可伪造的首值",
          cm_ncm_gateway.rate_key(_H({"X-Forwarded-For": "9.9.9.9, 5.6.7.8"})) == "5.6.7.8")
    check("都缺失时兜底 client_address",
          cm_ncm_gateway.rate_key(_H({})) == "127.0.0.1")

    print(f"\n通过 {len(PASSED)} · 跳过 {len(SKIPPED)} · 失败 {len(FAILED)}")
    if FAILED:
        print("失败项：")
        for f in FAILED:
            print("   -", f)
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
