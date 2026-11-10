"""Exercise the engine routes and credential boundary against a fake QQ service."""
from base64 import b64encode
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlencode, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cm_db
import cm_qq
import cm_qq_registry
from cm_server import Handler

QR = "a" * 48
USER_QQ = "1" * 64
OTHER_QQ = "2" * 64
EXPIRED = "3" * 64
NEW_QQ = "4" * 64


def serve(test, handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    test.addClassCleanup(worker.join, 3)
    test.addClassCleanup(server.server_close)
    test.addClassCleanup(server.shutdown)
    return server


def song(mid):
    return {"mid": mid, "id": 12, "name": "Fixture", "interval": 4,
            "album": {"mid": "a1", "name": "Album"}, "singer": [{"mid": "s1", "name": "Singer"}]}


class Upstream(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def handle_request(self):
        request = urlsplit(self.path)
        path = request.path
        query = {k: v[0] for k, v in parse_qs(request.query).items()}
        size = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(size)) if size else {}
        session = self.headers.get("X-QQ-Session")
        self.server.calls.append((self.command, path, query, body, dict(self.headers)))
        status, result = 200, {"code": 200}
        extra = {}

        if path == "/login/qr/key":
            result["data"] = {"unikey": QR}
        elif path == "/login/qr/create":
            result["data"] = {"qrimg": "data:image/png;base64,AAAA"}
        elif path == "/login/qr/check":
            result = {"code": 803, "cookie": "qqmusic_session=" + NEW_QQ}
            extra = {"Set-Cookie": "unrelated=1"}
        elif path == "/login/status":
            result["data"] = {"profile": {"name": "QQ"}} if session in (USER_QQ, OTHER_QQ) else {}
        elif path == "/login/refresh":
            result["data"] = {"token": session, "rotated": False}
        elif path == "/search":
            begin = (int(query["page"]) - 1) * 20
            result.update(total=60, more=begin < 40, items=[song(f"M{i}") for i in range(begin, begin + 20)])
        elif path == "/song/batch":
            result["results"] = [
                {"code": 200, "index": i, "song": song(item["mid"])}
                for i, item in reversed(list(enumerate(body["songs"])))
            ]
        elif path == "/getLyric":
            trans = b64encode("[00:01.25]译文".encode()).decode()
            result = {"response": {"code": 0, "lyric": "[00:01.25]Fixture lyrics\n[00:04]Second line", "trans": trans}}
        elif path == "/getAlbumInfo":
            result = {"response": {"code": 0, "data": {"mid": "a1", "name": "Album", "aDate": "2020-01-01",
                       "total_song_num": 1, "singermid": "s1", "list": [song("m1")]}}}
        elif path == "/getSingerAlbum":
            result = {"response": {"code": 0, "singer": {"code": 0, "data": {"total": 2,
                       "albumList": [{"albumMid": "a1", "albumName": "Album", "totalNum": 1}]}}}}
        elif path == "/singer/detail":
            result["singer"] = {"mid": "s1", "name": "Singer"}
        elif path == "/singer/songs":
            result.update(total=1, more=False, songs=[song("m1")])
        elif path == "/getSongListDetail":
            result = {"response": {"code": 0, "cdlist": [
                {"disstid": "001", "dissname": "Playlist", "songnum": 1, "songlist": [song("m1")]}]}}
        elif path == "/getMusicPlay":
            mid = query["songmid"]
            if session not in (USER_QQ, OTHER_QQ):
                status, result = 401, {"code": 401}
            else:
                url = "https://stream.qqmusic.qq.com/fixture.mp3" if mid != "Empty" else ""
                result["data"] = {"playUrl": {mid: {"url": url, "preview": mid == "Preview",
                                                    "quality": "320" if query["quality"] == "best" else query["quality"]}}}
        elif path == "/comment/list" and query.get("id") == "redirect":
            status, extra = 302, {"Location": "/login/status"}
        elif path == "/user/playlist":
            result["account"] = "a" if session == USER_QQ else "b"
        raw = json.dumps(result).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        for name, value in extra.items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(raw)

    do_GET = handle_request
    do_POST = handle_request


class QQMusicTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(tmp.cleanup)
        db = patch.object(cm_db, "DB_PATH", str(Path(tmp.name) / "qq.db"))
        db.start()
        cls.addClassCleanup(db.stop)
        cm_db.init()
        cls.ids = {
            user: cm_db.create_user("qqtest_" + user, "test fixture", user)
            for user in ("one", "two")
        }
        cls.users = {user: cm_db.issue_token(uid) for user, uid in cls.ids.items()}
        cls.upstream = serve(cls, Upstream)
        cls.upstream.calls = []
        cls.engine = serve(cls, Handler)
        base = patch.object(cm_qq, "BASE", f"http://127.0.0.1:{cls.upstream.server_port}")
        base.start()
        cls.addClassCleanup(base.stop)

    def setUp(self):
        self.upstream.calls.clear()
        with cm_qq._QR_LOCK:
            cm_qq._qr = None
            cm_qq._qr_completed.clear()
        for session, user in ((USER_QQ, "one"), (OTHER_QQ, "two"), (EXPIRED, "one")):
            cm_db.claim_qq_session(cm_qq._digest(session), self.ids[user])

    def request(self, path, *, method="GET", query=None, body=None, user=None, session=None, headers=None):
        headers = dict(headers or {})
        if user:
            headers["Authorization"] = f"Bearer {self.users[user]}"
        if session:
            headers["X-QQ-Session"] = session
        if body is not None:
            headers["Content-Type"] = "application/json"
        if query:
            path += "?" + urlencode(query)
        conn = HTTPConnection(*self.engine.server_address, timeout=5)
        try:
            conn.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
            response = conn.getresponse()
            raw = response.read()
            return response.status, response.headers, json.loads(raw) if raw else None
        finally:
            conn.close()

    def qq(self, path, **kwargs):
        status, headers, body = self.request("/qqmusic" + path, **kwargs)
        self.assertEqual(headers.get("Cache-Control"), "no-store")
        return status, headers, body

    def test_catalog_matches_allowlist(self):
        _, _, data = self.request("/station/api-catalog")
        items = next(group["items"] for group in data["groups"] if group["id"] == "qqmusic")
        self.assertEqual({(item["method"], item["path"], item["auth"]) for item in items},
                         {(r.method, "/qqmusic" + r.path, r.auth) for r in cm_qq_registry.ROUTES})

    def test_public_search_offset_and_no_cookie_leak(self):
        status, _, data = self.qq("/search", query={"keywords": "fixture", "type": "song", "offset": 19, "limit": 3},
                                  headers={"Cookie": "some_other_cookie=ignored"})
        self.assertEqual(status, 200)
        self.assertEqual([s["qq_mid"] for s in data["songs"]], ["M19", "M20", "M21"])
        self.assertEqual(data["songs"][0]["duration"], 4000)
        self.assertEqual(data["songs"][0]["provider"], "qqmusic")
        self.assertEqual(data["totals"], {"song": 60})
        self.assertEqual(data["hasMore"], {"song": True})
        self.assertEqual([q["page"] for _, _, q, _, _ in self.upstream.calls], ["1", "2"])
        for *_, headers in self.upstream.calls:
            self.assertNotIn("Cookie", headers)
            self.assertNotIn("X-QQ-Session", headers)

    def test_details_and_lyrics(self):
        mids = [f"M{i}" for i in range(23)]
        status, _, data = self.qq("/song/detail", query={"ids": ",".join(mids)})
        self.assertEqual(status, 200)
        self.assertEqual([s["id"] for s in data["songs"]], mids)
        self.assertEqual([len(body["songs"]) for _, _, _, body, _ in self.upstream.calls], [20, 3])
        status, _, data = self.qq("/lyric", query={"id": "M1"})
        self.assertEqual(status, 200)
        self.assertEqual(data["lines"][0]["t"], 1250)
        self.assertEqual(data["lines"][0]["trans"], "译文")
        self.assertTrue(data["lines"][0]["wSynth"])

    def test_catalog_adapters(self):
        for path, ident in (("/album", "a1"), ("/artist", "s1"), ("/playlist", "001")):
            with self.subTest(path=path):
                status, _, data = self.qq(path, query={"id": ident})
                self.assertEqual(status, 200)
                self.assertEqual(data["id"], ident)
                self.assertEqual(data["songs"][0]["qq_mid"], "m1")
        _, _, data = self.qq("/artist/albums", query={"id": "s1", "offset": 1, "limit": 1})
        self.assertEqual(data["albums"][0]["size"], 1)
        self.assertEqual(self.upstream.calls[-1][2]["page"], "1")

    def test_own_qr_session_and_credentials(self):
        path = "/login/qr/"
        self.assertEqual(self.qq(path + "key", method="POST", body={})[0], 401)
        self.assertEqual(self.qq(path + "key", method="POST", body={}, user="one")[2]["data"]["unikey"], QR)
        self.assertEqual(self.qq(path + "key", method="POST", body={}, user="two")[0], 409)
        self.assertEqual(self.qq(path + "create", method="POST", body={"key": QR}, user="one")[0], 200)
        self.assertEqual(self.qq(path + "check", method="POST", body={"key": QR}, user="two")[0], 404)
        status, headers, data = self.qq(path + "check", method="POST", body={"key": QR}, user="one")
        self.assertEqual(status, 200)
        self.assertEqual(data, {"code": 803, "data": {"session": NEW_QQ}})
        self.assertTrue(cm_db.qq_session_owned_by(cm_qq._digest(NEW_QQ), self.ids["one"]))
        self.assertIn("Path=/cm/qqmusic/", headers["Set-Cookie"])
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        self.assertNotIn("unrelated", headers["Set-Cookie"])
        self.assertEqual(self.qq(path + "check", method="POST", body={"key": QR}, user="one")[2], data)

    def test_session_isolation_and_expiry(self):
        path = "/native/user/playlist"
        self.assertEqual(self.qq(path, session=USER_QQ)[0], 401)
        self.assertEqual(self.qq(path, user="one")[0], 401)
        self.assertEqual(self.qq(path, user="two", session=USER_QQ)[0], 401)
        self.assertEqual(self.qq(path, session=USER_QQ, user="one")[2]["account"], "a")
        self.assertEqual(self.qq(path, user="two", headers={"Cookie": f"qqmusic_session={OTHER_QQ}; unrelated=secret"})[2]["account"], "b")
        for *_, headers in self.upstream.calls:
            self.assertNotIn("Authorization", headers)
            self.assertNotIn("Cookie", headers)
        self.assertEqual(self.qq("/login/status", session=EXPIRED, user="one")[0], 401)
        self.assertEqual(self.qq("/native/mv/url", session=EXPIRED, user="one")[0], 401)
        self.assertEqual(self.qq("/login/refresh", method="POST", session=USER_QQ, user="one")[0], 200)
        self.assertIn("Max-Age=0", self.qq("/logout", method="POST", body={"confirm": 1},
                                          session=USER_QQ, user="one")[1]["Set-Cookie"])
        self.assertEqual(self.qq(path, user="one", session=USER_QQ)[0], 401)

    def test_native_write_gate_and_redirect(self):
        path = "/native/user/song/like"
        self.assertEqual(self.qq(path, user="one", session=USER_QQ)[0], 405)
        self.assertEqual(self.qq(path, method="POST", body={}, user="one", session=USER_QQ)[0], 400)
        self.assertEqual(self.qq(path, method="POST", body={"confirm": 1, "cookie": USER_QQ},
                                 user="one", session=USER_QQ)[0], 400)
        self.assertEqual(self.qq(path, method="POST", body={"confirm": 1}, user="one",
                                 headers={"Cookie": f"qqmusic_session={USER_QQ}", "Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertFalse(self.upstream.calls)
        self.assertEqual(self.qq(path, method="POST", body={"confirm": 1, "mid": "M1"},
                                 user="one", session=USER_QQ)[0], 200)
        self.assertEqual(self.upstream.calls[-1][3], {"mid": "M1"})
        self.assertEqual(self.qq("/native/comment/list", query={"id": "redirect"})[0], 502)
        self.assertEqual(self.upstream.calls[-1][1], "/comment/list")
        self.assertEqual(self.qq("/native/login/qr/check")[0], 404)
        self.assertEqual(self.qq("/native/getLyric/../login")[0], 404)

    def test_playback_quality_and_no_anonymous_fallback(self):
        self.assertEqual(self.qq("/song/url", query={"id": "M1"}, user="one")[0], 401)
        self.assertFalse(self.upstream.calls)
        for mid, level, status, expected in (
            ("M1", "auto", 200, "exhigh"), ("M1", "lossless", 200, "lossless"),
            ("Empty", "auto", 422, None), ("Preview", "auto", 422, None),
            ("M1", "dolby", 422, None),
        ):
            code, _, data = self.qq("/song/url", query={"id": mid, "level": level}, user="one", session=USER_QQ)
            self.assertEqual(code, status)
            self.assertEqual(data.get("level"), expected)
        _, _, data = self.qq("/song/url", query={"id": "M1", "maxBr": "128000"}, user="one", session=USER_QQ)
        self.assertEqual(data["level"], "standard")
        self.assertEqual(self.qq("/song/url", query={"id": "M1"}, user="one", session=EXPIRED)[0], 401)
        self.assertTrue(all(headers.get("X-QQ-Session") for *_, headers in self.upstream.calls))

    def test_preflight_and_non_loopback_config(self):
        status, headers, _ = self.qq("/search", method="OPTIONS")
        self.assertEqual(status, 204)
        self.assertIn("X-QQ-Session", headers["Access-Control-Allow-Headers"])
        with patch.object(cm_qq, "BASE", "http://192.0.2.9:3200"):
            self.assertEqual(self.qq("/native/comment/list")[0], 503)
        self.assertFalse(self.upstream.calls)
