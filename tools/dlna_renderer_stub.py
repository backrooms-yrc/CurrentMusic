#!/usr/bin/env python3
"""最小 DLNA MediaRenderer 桩：用于验证 CurrentMusic 的 SSDP 发现与 AVTransport 控制。

只实现协议必需部分，不真放音频；每个动作都打印，便于断言序列：
  - SSDP: 绑定 239.255.255.250:1900，回应 M-SEARCH（urn:schemas-upnp-org:device:MediaRenderer:1）
  - HTTP: 提供 /desc.xml（设备描述）与 /ctrl（AVTransport SOAP 控制端点）
用法：
  python3 dlna_renderer_stub.py [端口] [--iface 127.0.0.1] [--fake-ip 45.207.204.178]
控制动作记录写入 /tmp/dlna-stub-calls.jsonl，供测试脚本断言。
"""
import argparse
import json
import os
import re
import select
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CALLS = "/tmp/dlna-stub-calls.jsonl"
STATE = {"uri": "", "meta": "", "state": "STOPPED", "pos": 0, "duration": 0}
LOCK = threading.Lock()

DESC = """<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>CurrentMusic 测试渲染器</friendlyName>
    <manufacturer>CurrentMusic</manufacturer>
    <modelName>StubRenderer</modelName>
    <UDN>uuid:currentmusic-stub-renderer</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
        <controlURL>/ctrl</controlURL>
        <eventSubURL>/evt</eventSubURL>
        <SCPDURL>/scpd.xml</SCPDURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>
        <controlURL>/ctrl-rc</controlURL>
        <SCPDURL>/scpd-rc.xml</SCPDURL>
      </service>
    </serviceList>
  </device>
</root>"""


def record(action, args):
    with open(CALLS, "a", encoding="utf-8") as f:
        f.write(json.dumps({"t": time.time(), "action": action, "args": args}, ensure_ascii=False) + "\n")


def soap_response(action, service="AVTransport"):
    body = {
        "SetAVTransportURI": "",
        "Play": "",
        "Pause": "",
        "Stop": "",
        "Seek": "",
        "GetPositionInfo": (
            f"<Track>1</Track><TrackDuration>0:03:30</TrackDuration>"
            f"<TrackURI>{STATE['uri']}</TrackURI>"
            f"<RelTime>0:00:{STATE['pos'] % 60:02d}</RelTime>"
        ),
        "GetTransportInfo": f"<CurrentTransportState>{STATE['state']}</CurrentTransportState>"
                            f"<CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>",
        "GetMediaInfo": f"<NrTracks>1</NrTracks><CurrentURI>{STATE['uri']}</CurrentURI>"
                        f"<CurrentURIMetaData></CurrentURIMetaData>",
    }.get(action, "")
    return (
        '<?xml version="1.0"?>'
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
        's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
        f'<s:Body><u:{action}Response xmlns:u="urn:schemas-upnp-org:service:{service}:1">'
        f"{body}</u:{action}Response></s:Body></s:Envelope>"
    )


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    fake_ip = "127.0.0.1"
    port = 0

    def log_message(self, *a):
        pass

    def _send(self, body, ctype, code=200):
        raw = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path.startswith("/desc.xml"):
            self._send(DESC, "text/xml; charset=utf-8")
        elif self.path.startswith("/scpd"):
            self._send('<?xml version="1.0"?><scpd xmlns="urn:schemas-upnp-org:service-1-0">'
                       "<actionList></actionList></scpd>", "text/xml; charset=utf-8")
        else:
            self._send("not found", "text/plain", 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode("utf-8", "replace")
        m = re.search(r"<u:(\w+)", body) or re.search(r"<(\w+)[^>]*xmlns:u=", body)
        action = re.search(r"<(?:\w+:)?(\w+)>\s*</", body)
        action = (m.group(1) if m else None) or (action.group(1) if action else "?")
        if action not in ("SetAVTransportURI", "Play", "Pause", "Stop", "Seek"):
            # 从 SOAPAction 头兜底解析
            sa = self.headers.get("SOAPAction", "")
            mm = re.search(r"#(\w+)", sa)
            if mm:
                action = mm.group(1)
        args = {k: v for k, v in re.findall(
            r"<(?:\w+:)?(\w+)>(.*?)</(?:\w+:)?\1>", body, re.S) if k != action}
        with LOCK:
            if action == "SetAVTransportURI":
                STATE["uri"] = args.get("CurrentURI", "")
                STATE["meta"] = args.get("CurrentURIMetaData", "")
                STATE["state"] = "STOPPED"
            elif action == "Play":
                STATE["state"] = "PLAYING"
            elif action == "Pause":
                STATE["state"] = "PAUSED_PLAYBACK"
            elif action == "Stop":
                STATE["state"] = "STOPPED"
            elif action == "Seek":
                STATE["pos"] = 42
        record(action, {"uri": args.get("CurrentURI", ""), "meta_len": len(args.get("CurrentURIMetaData", "")),
                        "state": STATE["state"]})
        service = "RenderingControl" if self.path.startswith("/ctrl-rc") else "AVTransport"
        self._send(soap_response(action, service), 'text/xml; charset="utf-8"')


def ssdp_loop(iface, http_port, fake_ip, stop, uni_port=1900, mcast=True):
    socks = []
    sock = None
    if mcast:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP,
                            socket.inet_aton("239.255.255.250") + socket.inet_aton(iface))
        except OSError as e:
            print(f"[ssdp] 加入组播失败（{iface}）: {e}")
        sock.bind(("239.255.255.250", 1900))
        socks.append(sock)
        print(f"[ssdp] 监听 239.255.255.250:1900（iface={iface}，通告 IP={fake_ip}）", flush=True)
    # 单播监听：容器/云主机常禁用组播回环，用它直接验证 M-SEARCH 报文本身
    uni = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    uni.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    uni.bind(("0.0.0.0", uni_port))
    socks.append(uni)
    print(f"[ssdp] 单播监听 0.0.0.0:{uni_port}（无组播回环环境下的报文校验）", flush=True)

    def reply(addr, text):
        if "M-SEARCH" not in text or "ssdp:discover" not in text:
            return
        st = re.search(r"ST:\s*(.+)", text)
        st = st.group(1).strip() if st else "ssdp:all"
        if "MediaRenderer" not in st and st not in ("ssdp:all", "upnp:rootdevice"):
            return
        print(f"[ssdp] 收到 M-SEARCH from {addr[0]}:{addr[1]} ST={st}", flush=True)
        usn = "uuid:currentmusic-stub-renderer::urn:schemas-upnp-org:device:MediaRenderer:1"
        resp = (
            "HTTP/1.1 200 OK\r\n"
            "CACHE-CONTROL: max-age=1800\r\n"
            "EXT:\r\n"
            f"LOCATION: http://{fake_ip}:{http_port}/desc.xml\r\n"
            "SERVER: Linux/1.0 UPnP/1.0 StubRenderer/1.0\r\n"
            f"ST: {st}\r\n"
            f"USN: {usn}\r\n"
            "BOOTID.UPNP.ORG: 1\r\n"
            "\r\n"
        )
        out = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        out.sendto(resp.encode(), addr)
        out.close()
        print(f"[ssdp] 已回应 → {addr}", flush=True)

    while not stop.is_set():
        # 用 select 同时等两个 socket：逐个阻塞 recvfrom 会让后者的报文一直排队
        try:
            ready, _, _ = select.select(socks, [], [], 1.0)
        except OSError:
            break
        for s in ready:
            try:
                data, addr = s.recvfrom(65535)
            except OSError:
                continue
            reply(addr, data.decode("utf-8", "replace"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("port", nargs="?", type=int, default=18800)
    ap.add_argument("--iface", default="127.0.0.1")
    ap.add_argument("--fake-ip", default="127.0.0.1")
    ap.add_argument("--uni-port", type=int, default=1900, help="单播 SSDP 监听端口（自测用）")
    ap.add_argument("--no-mcast", action="store_true", help="不加入组播组（纯单播自测）")
    a = ap.parse_args()
    if os.path.exists(CALLS):
        os.remove(CALLS)
    Handler.fake_ip, Handler.port = a.fake_ip, a.port
    stop = threading.Event()
    threading.Thread(target=ssdp_loop,
                     args=(a.iface, a.port, a.fake_ip, stop, a.uni_port, not a.no_mcast),
                     daemon=True).start()
    srv = ThreadingHTTPServer(("0.0.0.0", a.port), Handler)
    srv.daemon_threads = True
    print(f"[http] 控制端点 http://{a.fake_ip}:{a.port}/ctrl（描述 /desc.xml）", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()


if __name__ == "__main__":
    main()
