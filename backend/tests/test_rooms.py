"""通过真实 HTTP Handler 验证房间权限、事件和生命周期，使用独立临时 SQLite。"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from http.client import HTTPConnection
from pathlib import Path
import json
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cm_db
import cm_rooms
import cm_server


class RoomTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(patch.object(cm_db, "DB_PATH", str(Path(directory) / "rooms.db")))
        self.enterContext(patch.object(cm_server.cm_region, "note"))
        self.enterContext(patch.object(cm_server, "rate_limited", return_value=False))
        cm_db.init()
        with closing(cm_db.connect()) as conn:
            cm_rooms.init_room_tables(conn)
        self.users = {}
        for name in ("owner", "member", "guest"):
            uid = cm_db.create_user(name, "test fixture", name)
            self.users[name] = (uid, cm_db.issue_token(uid))
        self.server = cm_server.ThreadingHTTPServer(("127.0.0.1", 0), cm_server.Handler)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def request(self, method, path, user="owner", body=None, status=200, headers=None):
        headers = dict(headers or {})
        if user:
            headers["Authorization"] = "Bearer " + self.users[user][1]
        with closing(HTTPConnection(*self.server.server_address, timeout=6)) as conn:
            conn.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
            response = conn.getresponse()
            data = json.loads(response.read())
        if isinstance(status, tuple):
            self.assertIn(response.status, status, data)
            return response.status
        self.assertEqual(response.status, status, data)
        return data

    def create(self, **fields):
        return self.request("POST", "/rooms", body={"name": "测试房间", **fields})["room"]

    def test_archive_reopen_and_delete(self):
        room = self.create(isPublic=False, password="fixture", joinLocked=True)
        rid = room["id"]
        path = f"/rooms/{rid}"
        self.assertEqual(self.request("GET", "/rooms")["total"], 0)
        self.assertEqual(self.request("GET", "/rooms?scope=mine")["total"], 1)
        self.assertEqual(self.request("GET", "/rooms?scope=mine", "guest")["total"], 0)
        self.request("DELETE", path, "guest", status=403)
        self.request("POST", path + "/leave")
        joined = self.request("POST", path + "/join")
        self.assertEqual(joined["role"], "owner")
        song = {"ncm_id": 1, "name": "保留队列"}
        self.request("POST", path + "/queue", body=song)
        closed = self.request("POST", path + "/close")["room"]
        self.assertEqual(closed["archiveReason"], "manual")
        self.assertEqual(self.request("POST", path + "/close")["room"]["archivedAt"], closed["archivedAt"])
        self.request("POST", path + "/join", status=404)
        self.request("GET", path, "guest", status=404)
        self.assertEqual(self.request("POST", path + "/reopen")["room"]["code"], room["code"])
        self.assertEqual(self.request("GET", path + "/queue")["queue"][0]["name"], song["name"])
        self.request("DELETE", path)
        self.request("GET", path, status=404)
        self.request("GET", "/rooms/search?code=" + room["code"], status=404)
        with cm_rooms.transaction() as conn:
            for table in ("room_members", "room_queue", "room_events", "room_bans"):
                self.assertEqual(conn.execute(f"SELECT COUNT(*) FROM {table} WHERE room_id=?", (rid,)).fetchone()[0], 0)

    def test_idle_archive_checks_persisted_activity_and_can_be_deleted(self):
        idle, active = self.create(), self.create()
        cutoff = int(time.time()) - cm_rooms.IDLE_SECONDS - 5
        with cm_rooms.transaction(write=True) as conn:
            conn.execute("UPDATE rooms SET updated_at=?", (cutoff,))
            conn.execute("UPDATE room_members SET last_seen=? WHERE room_id=?", (cutoff, idle["id"]))
        self.assertEqual(cm_rooms.archive_idle_rooms(), 1)
        self.assertEqual(cm_rooms.archive_idle_rooms(), 0)
        mine = {room["id"]: room for room in self.request("GET", "/rooms?scope=mine")["rooms"]}
        self.assertEqual(mine[idle["id"]]["archive_reason"], "idle")
        self.assertEqual(mine[active["id"]]["closed_at"], 0)
        self.request("DELETE", f"/rooms/{idle['id']}")

    def test_private_state_and_queue_permissions(self):
        room = self.create(password="fixture", isPublic=False)
        path = f"/rooms/{room['id']}"
        self.request("POST", path + "/join", "member", body={"password": "wrong"}, status=403)
        self.request("POST", path + "/join", "member", body={"password": "fixture"})
        self.request("POST", path + "/join", "member")
        self.request("GET", path + "/events", "guest", status=403)
        self.request("POST", path + "/sync", "guest", status=403)
        self.request("POST", path + "/stream/renew", "guest", status=403)
        self.assertIsNone(self.request("GET", path, "guest")["timeline"])
        pending = self.request("POST", path + "/queue", "member", {"ncm_id": 12, "name": "待审批"})
        qid = pending["item"]["id"]
        self.assertFalse(pending["auto"])
        self.request("POST", path + "/join", "guest", {"password": "fixture"})
        self.assertEqual(self.request("GET", path + "/queue", "guest")["queue"], [])
        self.assertTrue(self.request("GET", path, "member")["queue"][0]["mine"])
        self.assertEqual(self.request("GET", path, "guest")["queue"], [])
        self.request("DELETE", f"{path}/queue/{qid}", "guest", status=403)
        self.request("POST", path + "/settings", body={"password": "updated", "needApproval": False, "name": "新名字"})
        self.request("POST", f"{path}/queue/{qid}/approve")
        self.request("POST", f"{path}/queue/{qid}/approve", status=409)
        auto = self.request("POST", path + "/queue", "member", {"ncm_id": 13, "name": "免审批"})
        self.assertTrue(auto["auto"])
        self.request("POST", path + "/queue/reorder", body={"qid": auto["item"]["id"], "index": 0})
        self.assertEqual(self.request("GET", path + "/queue")["queue"][0]["ncmId"], 13)
        events = self.request("GET", path + "/events", "guest")["events"]
        self.assertEqual(next(e for e in events if e["type"] == "settings")["payload"], {})
        self.assertEqual(next(e for e in events if e["type"] == "queue")["payload"], {"action": "add"})

    def test_capacity_and_persistent_cursor(self):
        room = self.create()
        path = f"/rooms/{room['id']}"
        with cm_rooms.transaction(write=True) as conn:
            cm_rooms.update_room(conn, room["id"], {"max_members": 2})
        with ThreadPoolExecutor(max_workers=2) as pool:
            def join(user):
                return self.request("POST", path + "/join", user, status=(200, 409))
            self.assertEqual(sorted(pool.map(join, ["guest", "member"])), [200, 409])
        with cm_rooms.transaction(write=True) as conn:
            cursor = cm_rooms.latest_seq(conn, room["id"])
            for _ in range(cm_rooms.MAX_EVENTS_PER_ROOM + 1):
                cm_rooms.emit_event(conn, room["id"], "settings", {})
        with closing(cm_db.connect()) as conn:
            cm_rooms.init_room_tables(conn)
        result = self.request("GET", path + f"/events?since={cursor}")
        self.assertEqual(result["events"][0]["type"], "reset")
        self.request("POST", path + "/settings", body={"freeMode": True})
        after = self.request("GET", path + "/events", headers={"Last-Event-ID": str(result["latestSeq"])})
        self.assertEqual([e["seq"] for e in after["events"]], [result["latestSeq"] + 1])

    def test_roles_and_terminal_sse_on_removal(self):
        room = self.create()
        path = f"/rooms/{room['id']}"
        member_id = self.users["member"][0]
        joined = self.request("POST", path + "/join", "member")
        self.request("POST", path + "/admins", body={"userId": member_id, "on": True})
        self.request("POST", path + "/transfer", body={"userId": member_id})
        self.assertEqual(self.request("GET", path)["role"], "admin")
        self.assertEqual(self.request("GET", path, "member")["role"], "owner")
        self.request("POST", path + "/settings", status=403)
        self.request("POST", path + "/kick", body={"userId": member_id}, status=400)
        with closing(HTTPConnection(*self.server.server_address, timeout=6)) as stream:
            stream.request("GET", path + f"/events?sse=1&since={joined['latestSeq']}",
                           headers={"Authorization": "Bearer " + self.users["owner"][1]})
            response = stream.getresponse()
            self.assertEqual(response.status, 200)
            self.request("POST", path + "/kick", "member", {"userId": self.users["owner"][0], "ban": True})
            self.assertIn(b'"reason": "removed"', response.read())
        self.request("POST", path + "/heartbeat", status=403)
        self.request("POST", path + "/join", status=403)
        self.assertEqual(self.request("GET", path + "/bans", "member")["bans"][0]["userId"], self.users["owner"][0])
        self.request("DELETE", f"{path}/bans/{self.users['owner'][0]}", "member")
        self.assertEqual(self.request("POST", path + "/join")["role"], "member")

    def test_switch_failure_is_atomic_and_previous_requeues_current(self):
        path = f"/rooms/{self.create()['id']}"
        for ncm_id in (10, 20):
            self.request("POST", path + "/queue", body={"ncm_id": ncm_id, "name": str(ncm_id)})
        with patch.object(cm_server, "_resolve_room_stream", side_effect=cm_rooms.RoomError(502, "unavailable")):
            self.request("POST", path + "/next", status=502)
        self.assertEqual([item["status"] for item in self.request("GET", path + "/queue")["queue"]],
                         ["queued", "queued"])
        stream = {"stream_url": "https://example.test/audio.mp3", "stream_level": "standard",
                  "stream_expire_at": cm_rooms.now_ms() + 100}
        with patch.object(cm_server, "_resolve_room_stream", return_value=stream):
            first = self.request("POST", path + "/next")["timeline"]
            second = self.request("POST", path + "/next")["timeline"]
            self.request("POST", path + "/next", body={"trackRevision": first["trackRevision"]}, status=409)
            self.assertEqual(second["trackNcmId"], 20)
            previous = self.request("POST", path + "/prev")["timeline"]
            self.assertEqual(previous["trackNcmId"], 10)
            self.assertEqual(self.request("GET", path + "/queue")["queue"][1]["status"], "queued")
            paused = self.request("POST", path + "/pause")["timeline"]
            self.assertFalse(paused["playing"])
            self.assertGreaterEqual(paused["basePosition"], 0)
            self.request("POST", path + "/seek", body={"position": 500})
            renewed = self.request("POST", path + "/stream/renew")["timeline"]
            self.assertEqual(renewed["basePosition"], 500)
            self.assertFalse(renewed["playing"])

    def test_legacy_room_migration_preserves_cursor_and_scrubs_settings(self):
        room = self.create()
        rid = room["id"]
        with cm_rooms.transaction(write=True) as conn:
            conn.execute("ALTER TABLE rooms DROP COLUMN archive_reason")
            conn.execute("ALTER TABLE rooms DROP COLUMN track_revision")
            conn.execute("ALTER TABLE room_queue DROP COLUMN play_order")
            conn.execute("UPDATE room_members SET role='member' WHERE room_id=?", (rid,))
            conn.execute("""INSERT INTO room_events VALUES(?,20,'settings','{"password":"legacy-fixture"}',0)""", (rid,))
            conn.execute("UPDATE rooms SET closed_at=1000,playing=1 WHERE id=?", (rid,))
        with closing(cm_db.connect()) as conn:
            cm_rooms.init_room_tables(conn)
        with cm_rooms.transaction() as conn:
            loaded = cm_rooms.room_by_ident(conn, str(rid))
            self.assertEqual(loaded["archive_reason"], "manual")
            self.assertFalse(loaded["playing"])
            self.assertEqual(cm_rooms.get_member(conn, rid, self.users["owner"][0])["role"], "owner")
            self.assertEqual(cm_rooms.event_batch(conn, rid, 19)[0][0]["payload"], {})
            self.assertEqual(cm_rooms.latest_seq(conn, rid), 20)
