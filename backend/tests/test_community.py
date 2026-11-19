"""Community profile and post API tests using the temporary route test harness."""
import base64
import io
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cm_db
import cm_server
import test_password_reset as harness


class TestCommunity(unittest.TestCase):
    setUp = harness.TestPasswordReset.setUp
    _cleanup = harness.TestPasswordReset._cleanup
    call = harness.TestPasswordReset.call

    def user(self, name):
        uid = cm_db.create_user(name, "fixture-password", name)
        return uid, cm_db.issue_token(uid, "fixture-device")

    def test_old_posts_migrate_and_current_post_detail_matches_list(self):
        uid, token = self.user("author")
        other_id, other = self.user("reader")
        attachment = {"type": "song", "id": 42, "name": "夜间通勤"}
        with cm_db.connect() as db:
            db.execute("ALTER TABLE posts DROP COLUMN title")
            old_id = db.execute(
                "INSERT INTO posts(user_id, content, created_at) VALUES (?, ?, ?)",
                (uid, "**旧帖**", 123),
            ).lastrowid
        cm_db.init()
        cm_db.init()
        self.assertEqual(self.call("GET", f"/posts/{old_id}")[1]["post"]["title"], "")
        self.assertEqual(self.call("GET", f"/posts/{old_id}")[1]["post"]["content"], "**旧帖**")
        self.assertEqual(self.call("POST", "/posts", {"content": "旧客户端正文"}, token=other)[0], 200)
        payload = {"title": " 夜间通勤  ", "content": "**正文**", "attachments": [attachment]}
        self.assertEqual(self.call("POST", "/posts", payload)[0], 401)
        code, created = self.call("POST", "/posts", payload, token=token)
        self.assertEqual(code, 200)
        post_id = created["id"]
        self.assertEqual(self.call("POST", f"/posts/{post_id}/like", {"on": True}, token=other)[0], 200)
        _, listing = self.call("GET", f"/posts?author={uid}&limit=1", token=other)
        self.assertEqual(listing["total"], 2)
        self.assertEqual(self.call("GET", f"/posts?author={other_id}")[1]["total"], 1)
        _, detail = self.call("GET", f"/posts/{post_id}", token=other)
        self.assertEqual(detail["post"], listing["posts"][0])
        self.assertEqual(detail["post"]["title"], "夜间通勤")
        self.assertEqual(detail["post"]["attachments"], [attachment])
        self.assertTrue(detail["post"]["likedByMe"])
        self.assertFalse(detail["post"]["canDelete"])
        self.assertTrue(self.call("GET", f"/posts/{post_id}", token=token)[1]["post"]["canDelete"])
        self.assertFalse(self.call("GET", f"/posts/{post_id}")[1]["post"]["likedByMe"])
        self.assertEqual(self.call("DELETE", f"/posts/{post_id}", token=other)[0], 403)
        self.assertEqual(self.call("DELETE", f"/posts/{post_id}", token=token)[0], 200)
        self.assertEqual(self.call("GET", f"/posts/{post_id}")[0], 404)
        self.assertEqual(self.call("POST", f"/posts/{post_id}/like", {"on": True}, token=other)[0], 404)

    def test_title_validation_and_comment_cursor(self):
        uid, token = self.user("author")
        for title in ("字" * 81, "两行\n标题", "两行\u2028标题", 80, []):
            self.assertEqual(self.call("POST", "/posts", {"title": title, "content": "正文"}, token=token)[0], 400)
        self.assertEqual(self.call("POST", "/posts", {"title": "仅标题"}, token=token)[0], 400)
        code, data = self.call("POST", "/posts", {"title": "🎧" * 80, "content": "正文"}, token=token)
        self.assertEqual(code, 200)
        post_id = data["id"]
        first = cm_db.post_comment_add(uid, post_id, "第一条")
        rest = [cm_db.post_comment_add(uid, post_id, f"第 {i + 2} 条", first) for i in range(101)]
        route = f"/posts/{post_id}/comments"
        old = self.call("GET", route)[1]
        self.assertEqual(set(old), {"comments"})
        self.assertEqual(len(old["comments"]), 100)
        _, page1 = self.call("GET", route + "?limit=30")
        self.assertEqual(len(page1["comments"]), 30)
        self.assertEqual(page1["nextAfter"], rest[28])
        _, page2 = self.call("GET", route + f"?after={page1['nextAfter']}&limit=100")
        self.assertEqual([c["id"] for c in page2["comments"]], rest[29:])
        self.assertEqual(page2["comments"][0]["replyTo"]["id"], first)
        self.assertIsNone(page2["nextAfter"])
        for query in ("after=-1", "after=999999999999999999999", "limit=0", "limit=101", "limit=no"):
            self.assertEqual(self.call("GET", route + "?" + query)[0], 400)

    def test_banner_upload_replace_remove_and_visibility(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("Pillow unavailable")

        def encode(color, image_format):
            out = io.BytesIO()
            image = Image.new("RGB", (400, 900), color)
            exif = image.getexif()
            exif[274] = 6
            exif[270] = "fixture metadata"
            image.save(out, image_format, exif=exif)
            return {"data": base64.b64encode(out.getvalue()).decode("ascii")}

        uid, token = self.user("banner-owner")
        other_id, other = self.user("banner-viewer")
        public = f"/users/{uid}/profile"
        banner = "/profile/banner"
        original = encode((250, 40, 15), "JPEG")
        self.assertEqual(self.call("GET", public)[1]["user"]["bannerUrl"], "")
        self.assertEqual(self.call("PUT", banner, original)[0], 401)
        self.assertEqual(self.call("DELETE", banner)[0], 401)
        self.assertEqual(self.call("PUT", banner + "?token=" + token, original)[0], 401)
        code, result = self.call("PUT", banner, original, token=token)
        self.assertEqual(code, 200)
        path = result["bannerUrl"]
        self.assertEqual(self.call("GET", public)[1]["user"]["bannerUrl"], path)
        self.assertEqual(self.call("GET", "/auth/me", token=token)[1]["bannerUrl"], path)
        self.assertEqual(self.call("GET", "/profile", token=token)[1]["bannerUrl"], path)
        self.assertEqual(self.call("DELETE", banner, token=other)[0], 200)
        self.assertEqual(self.call("GET", f"/users/{other_id}/profile")[1]["user"]["bannerUrl"], "")

        handler = harness._Handler("GET", path)
        headers = {}
        handler.send_header = lambda key, value: headers.update({key: value})
        cm_server.route(handler, "GET")
        self.assertEqual(handler.status, 200)
        self.assertEqual(headers["Content-Type"], "image/jpeg")
        with Image.open(io.BytesIO(handler.wfile.getvalue())) as image:
            self.assertEqual(image.size, (900, 225))
            self.assertFalse(image.getexif())
        cached = harness._Handler("GET", path)
        cached.headers["If-None-Match"] = headers["ETag"]
        cm_server.route(cached, "GET")
        self.assertEqual(cached.status, 304)
        self.assertEqual(cached.wfile.getvalue(), b"")

        for invalid in ({"data": "lol"}, {"data": base64.b64encode(b"x" * (1024 * 1024 + 1)).decode()}, []):
            self.assertEqual(self.call("PUT", banner, invalid, token=token)[0], 400)
            self.assertEqual(self.call("GET", public)[1]["user"]["bannerUrl"], path)
        code, result = self.call("PUT", banner, encode((5, 200, 20), "PNG"), token=token)
        self.assertEqual(code, 200)
        self.assertNotEqual(path, result["bannerUrl"])
        self.assertEqual(self.call("GET", path)[0], 404)
        for _ in range(2):
            self.assertEqual(self.call("DELETE", banner, token=token), (200, {"bannerUrl": ""}))
        self.assertEqual(self.call("GET", result["bannerUrl"])[0], 404)
        self.assertEqual(self.call("GET", public)[1]["user"]["bannerUrl"], "")
