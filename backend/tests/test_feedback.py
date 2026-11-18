import http.client
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import warnings
import zipfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_ai
import cm_db
import cm_feedback as feedback
import cm_feedback_diagnostics as diagnostics
import cm_feedback_media as media
import cm_server


class TestFeedback(unittest.TestCase):
    REQUEST = "7f36287d51474c66957b3f5930604a99"
    UID = 91
    TEXT = "从横屏切回竖屏后，歌词仍是横屏布局。\n版本是 1.2.5。"

    def setUp(self):
        cm_db.init()
        with cm_db.connect() as conn:
            conn.execute("DELETE FROM feedback_receipts")
        token = mock.patch.dict(os.environ, {"CM_FEEDBACK_GITHUB_TOKEN": "test-only"})
        token.start()
        self.addCleanup(token.stop)

    def submit(self, **overrides):
        body = {"requestId": self.REQUEST, "content": self.TEXT, "public": True}
        body.update(overrides)
        return feedback.submit(self.UID, body)

    def test_request_requires_login_and_public_consent(self):
        req = SimpleNamespace(path="/feedback", headers={}, rfile=BytesIO(),
                              client_address=("127.0.0.1", 0))
        with self.assertRaises(cm_server.ApiError) as err:
            cm_server.route(req, "POST")
        self.assertEqual(err.exception.code, 401)
        with self.assertRaises(feedback.FeedbackError) as err:
            self.submit(public=1)
        self.assertEqual(err.exception.code, 400)

    def test_receipt_is_scoped_and_submission_is_idempotent(self):
        with mock.patch.object(feedback.threading, "Thread") as worker:
            self.assertEqual(self.submit()["status"], "processing")
            self.assertEqual(self.submit()["status"], "processing")
            worker.assert_called_once()
        with self.assertRaises(feedback.FeedbackError) as err:
            feedback.status(self.UID + 1, self.REQUEST)
        self.assertEqual(err.exception.code, 404)

    def test_model_failure_falls_back_to_redacted_original(self):
        text = feedback.clean(self.TEXT + "\n邮箱：tester@example.invalid\n我的密码：do-not-publish")
        with mock.patch.dict(os.environ, {"CM_AI_ZAI_KEY": "test", "CM_AI_KEY": "test"}), \
                mock.patch.object(cm_db, "get_ai_settings", return_value=(True, "low")), \
                mock.patch.object(cm_ai, "_chat_stream", side_effect=cm_ai.AiError("timeout")) as ai, \
                mock.patch.object(feedback, "_create_issue", return_value=("published", 123)) as github, \
                mock.patch.object(feedback.threading, "Thread"):
            self.submit()
            feedback._run(self.UID, self.REQUEST, text, "test-only")
        self.assertEqual([(call.args[0].id, call.args[0].effort) for call in ai.call_args_list],
                         [("zai", "max"), ("deepseek", "max")])
        issue = github.call_args.args[1]
        self.assertEqual(issue["title"], self.TEXT.splitlines()[0])
        self.assertNotIn("labels", issue)
        self.assertIn(self.TEXT, issue["body"])
        self.assertNotIn("tester@example.invalid", issue["body"])
        self.assertNotIn("do-not-publish", issue["body"])
        self.assertEqual(feedback.status(self.UID, self.REQUEST), {
            "requestId": self.REQUEST, "status": "published", "issueNumber": 123,
            "issueUrl": "https://github.com/bileizhen/CurrentMusicX/issues/123",
        })

    def test_primary_failure_uses_formatted_fallback(self):
        content = json.dumps({
            "type": "bug", "title": "[Bug] 竖屏歌词布局错误",
            "fields": {"version": "1.2.5", "module": "歌词", "steps": "从横屏切回竖屏",
                       "result": "实际结果：歌词仍为横屏布局。\n\n预期结果：恢复竖屏布局。"},
        })
        result = {"content": content, "tool_calls": []}
        invalid = {"content": '{"type":"bug","title":"测试","fields":{"unknown":"无效字段"}}', "tool_calls": []}
        with mock.patch.dict(os.environ, {"CM_AI_ZAI_KEY": "test", "CM_AI_KEY": "test"}), \
                mock.patch.object(cm_db, "get_ai_settings", return_value=(True, "low")), \
                mock.patch.object(cm_ai, "_chat_stream", side_effect=[invalid, result]), \
                mock.patch.object(feedback, "_create_issue", return_value=("published", 123)) as github, \
                mock.patch.object(feedback.threading, "Thread"):
            self.submit()
            feedback._run(self.UID, self.REQUEST, self.TEXT, "test-only")
        issue = github.call_args.args[1]
        self.assertEqual(issue["title"], "[Bug] 竖屏歌词布局错误")
        self.assertEqual(issue["labels"], ["bug"])
        self.assertIn("### 应用版本\n\n1.2.5", issue["body"])
        self.assertIn("### 安装来源\n\n不清楚", issue["body"])
        self.assertIn("### 问题模块\n\n歌词", issue["body"])
        self.assertIn("预期结果：恢复竖屏布局。", issue["body"])
        self.assertIn("### 提交前确认\n\n- [ ]", issue["body"])

    def test_feature_fields_and_dropdowns(self):
        issue = feedback._template_issue("feature", "增加歌词字号选择", {
            "module": "无效的分类",
            "problem": "远离设备时难以看清歌词。",
            "proposal": "加入字号选择。\n### 问题模块",
        })
        self.assertEqual(issue["title"], "[Feature] 增加歌词字号选择")
        self.assertEqual(issue["labels"], ["enhancement"])
        self.assertIn("### 问题模块\n\n其他", issue["body"])
        self.assertIn("### 需求与使用场景\n\n远离设备时难以看清歌词。", issue["body"])
        self.assertIn("### 替代方案与补充信息\n\n_No response_", issue["body"])
        self.assertEqual(issue["body"].count("### 问题模块"), 1)

    def test_rejection_and_uncertain_publish(self):
        with mock.patch.object(feedback.threading, "Thread"):
            self.submit()
        with mock.patch.object(cm_ai, "format_feedback", return_value=None), \
                mock.patch.object(feedback, "_create_issue") as github:
            feedback._run(self.UID, self.REQUEST, self.TEXT, "test-only")
        github.assert_not_called()
        self.assertEqual(feedback.status(self.UID, self.REQUEST)["status"], "rejected")

        feedback._set_status(self.UID, self.REQUEST, "publishing")
        feedback.recover()
        self.assertEqual(self.submit()["status"], "unconfirmed")


class TestFeedbackDiagnostics(unittest.TestCase):
    REQUEST = "a" * 32
    CONTENT = "[Bug] 竖屏歌词布局错误\n复现步骤：从横屏切回竖屏。"

    @classmethod
    def setUpClass(cls):
        cm_db.init()
        uid = cm_db.create_user("feedback-tester", "test-password", "反馈测试")
        cls.token = cm_db.issue_token(uid)
        admin = cm_db.create_user("feedback-admin", "test-password", "反馈管理员")
        cm_db.set_admin(admin)
        cls.admin_token = cm_db.issue_token(admin)
        cls.server = cm_server.ThreadingHTTPServer(("127.0.0.1", 0), cm_server.Handler)
        cls.addClassCleanup(cls.server.server_close)
        thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        thread.start()
        cls.addClassCleanup(cls.server.shutdown)

    def setUp(self):
        with cm_db.connect() as conn:
            conn.execute("DELETE FROM feedback_receipts")
            conn.execute("DELETE FROM feedback_diagnostics")
            conn.execute("DELETE FROM feedback_media")
            conn.execute("DELETE FROM feedback_media_groups")
            conn.execute("DELETE FROM feedback_media_quota")
        self.storage = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(mock.patch.dict(os.environ, {
            "CM_FEEDBACK_GITHUB_TOKEN": "test-only",
            "CM_FEEDBACK_DIAGNOSTICS_DIR": str(self.storage),
            "CM_FEEDBACK_DIAGNOSTICS_ORIGIN": "https://music.example.invalid",
        }))

    def call(self, method, path, token=None, body=None, headers=None):
        headers = dict(headers or {})
        if token:
            headers["Authorization"] = "Bearer " + token
        with closing(http.client.HTTPConnection(*self.server.server_address, timeout=5)) as conn:
            conn.request(method, path, body=body, headers=headers)
            with conn.getresponse() as response:
                data = response.read()
                if response.getheader("Content-Type", "").startswith("application/json"):
                    data = json.loads(data)
                return response.status, data, dict(response.getheaders())

    @staticmethod
    def archive(log=b"Log line with tester@example.invalid and a harmless marker", entries=None):
        buffer = BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, value in entries or [("diagnostics.txt", b"version=1.2.5"), ("logs.txt", log)]:
                archive.writestr(name, value)
        return buffer.getvalue()

    def upload(self, archive, content=None, consent="true", token=None, public="true", media_fields=None):
        boundary = "TestFeedbackBoundary"
        body = []
        for name, value in {"requestId": self.REQUEST, "content": content or self.CONTENT,
                            "public": public, "diagnosticsConsent": consent, **(media_fields or {})}.items():
            body.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
        body.extend([f'--{boundary}\r\nContent-Disposition: form-data; name="diagnostics"; filename="d.zip"\r\n'
                     'Content-Type: application/zip\r\n\r\n'.encode(), archive, f'\r\n--{boundary}--\r\n'.encode()])
        return self.call("POST", "/feedback", token, b"".join(body),
                         {"Content-Type": f"multipart/form-data; boundary={boundary}"})

    def wait_for_receipt(self, state):
        for _ in range(100):
            status, body, _ = self.call("GET", f"/feedback?requestId={self.REQUEST}", self.token)
            if status == 200 and body["status"] == state:
                return body
            time.sleep(0.02)
        self.fail(f"receipt did not reach {state}")

    def test_multipart_publishes_once_and_downloads_only_for_admin(self):
        archive = self.archive()
        with mock.patch.object(cm_ai, "format_feedback", side_effect=cm_ai.AiError("offline")) as ai, \
                mock.patch.object(feedback, "_create_issue", return_value=("published", 12)) as github:
            with ThreadPoolExecutor(max_workers=2) as pool:
                responses = list(pool.map(lambda _: self.upload(archive, token=self.token), range(2)))
            for status, body, _ in responses:
                self.assertEqual(status, 202)
                self.assertTrue(body["hasDiagnostics"])
            receipt = self.wait_for_receipt("published")
            self.assertEqual(self.upload(archive, token=self.token)[:2], (202, receipt))
            github.assert_called_once()
            ai.assert_called_once_with(self.CONTENT)
            issue = github.call_args.args[1]
        self.assertEqual(receipt["issueNumber"], 12)
        self.assertEqual(receipt["issueUrl"], "https://github.com/bileizhen/CurrentMusicX/issues/12")
        self.assertEqual(issue["labels"], ["bug"])
        self.assertIn("### 复现步骤\n\n从横屏切回竖屏。", issue["body"])
        self.assertIn("### 截图与诊断信息\n\n[在 CurrentMusic 管理员面板下载诊断附件]", issue["body"])
        self.assertNotIn("harmless marker", issue["body"])
        with cm_db.connect() as conn:
            attachment = conn.execute("SELECT id,object_key FROM feedback_diagnostics").fetchone()
        self.assertNotIn(attachment["object_key"], issue["body"])
        self.assertIn("https://music.example.invalid/app/#/admin?diagnostics=" + attachment["id"], issue["body"])
        self.assertEqual(len(list(self.storage.iterdir())), 1)
        url = "/admin/feedback/diagnostics/" + attachment["id"]
        self.assertEqual(self.call("GET", url)[0], 401)
        self.assertEqual(self.call("GET", url, self.token)[0], 403)
        with self.assertLogs("cm", level="INFO") as audit:
            status, data, headers = self.call("GET", url, self.admin_token)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "private, no-store")
        self.assertTrue(any("诊断下载审计" in line and attachment["id"] in line for line in audit.output))
        with zipfile.ZipFile(BytesIO(data)) as saved:
            self.assertEqual(saved.read("logs.txt"), b"Log line with [REDACTED] and a harmless marker")
        self.assertEqual(self.upload(archive, content=self.CONTENT + " 修改", token=self.token)[0], 409)
        self.assertEqual(self.upload(self.archive(b"Other bytes"), token=self.token)[0], 409)
        body = json.dumps({"requestId": self.REQUEST, "content": self.CONTENT, "public": True})
        self.assertEqual(self.call("POST", "/feedback", self.token, body, {"Content-Type": "application/json"})[0], 409)

    def test_invalid_or_unavailable_attachment_is_not_accepted(self):
        archive = self.archive()
        self.assertEqual(self.upload(archive)[0], 401)
        self.assertEqual(self.upload(archive, consent="false", token=self.token)[0], 400)
        self.assertEqual(self.upload(archive, public="false", token=self.token)[0], 400)
        self.assertEqual(self.upload(archive, content="[Feature] 增加歌词字号选项", token=self.token)[0], 400)
        self.assertEqual(self.upload(b"broken", token=self.token)[0], 400)
        self.assertEqual(self.upload(self.archive(b"x" * diagnostics.MAX_EXPANDED), token=self.token)[0], 413)
        self.assertEqual(self.upload(b"x" * (diagnostics.MAX_ZIP + 1), token=self.token)[0], 413)
        for name, value in [("subdir/logs.txt", b"text"), ("logs.txt", b"\x00")]:
            self.assertEqual(self.upload(self.archive(entries=[("diagnostics.txt", b"text"), (name, value)]),
                                         token=self.token)[0], 400)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            duplicate = self.archive(entries=[("logs.txt", b"a"), ("logs.txt", b"b")])
        self.assertEqual(self.upload(duplicate, token=self.token)[0], 400)
        with mock.patch.object(diagnostics, "store", side_effect=diagnostics.DiagnosticsError(503, "unavailable")):
            self.assertEqual(self.upload(archive, token=self.token)[0], 503)
        with cm_db.connect() as conn:
            conn.execute("CREATE TRIGGER fail_feedback_receipt BEFORE INSERT ON feedback_receipts "
                         "BEGIN SELECT RAISE(ABORT, 'test write failure'); END")
        try:
            self.assertEqual(self.upload(archive, token=self.token)[0], 503)
        finally:
            with cm_db.connect() as conn:
                conn.execute("DROP TRIGGER fail_feedback_receipt")
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM feedback_diagnostics").fetchone()[0], 0)
        self.assertFalse(list(self.storage.iterdir()))
        self.assertEqual(self.call("GET", f"/feedback?requestId={self.REQUEST}", self.token)[0], 404)

    def enable_media(self):
        if not (importlib.util.find_spec("PIL") and shutil.which("ffmpeg") and shutil.which("ffprobe")):
            self.skipTest("feedback media needs Pillow, FFmpeg, and ffprobe")
        folder = self.storage / "media"
        folder.mkdir(mode=0o700)
        address, port = self.server.server_address
        self.enterContext(mock.patch.dict(os.environ, {"CM_FEEDBACK_MEDIA_HOSTS": f"{address}:{port}"}))
        return folder

    @staticmethod
    def png(width=40, color="red"):
        from PIL import Image, PngImagePlugin
        buffer = BytesIO()
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text("Title", "private-source-text")
        Image.new("RGB", (width, 20), color).save(buffer, "PNG", pnginfo=metadata)
        return buffer.getvalue()

    def put_media(self, data, slot="screenshot-1", content_type="image/png", *, token=None, consent="true"):
        return self.call("PUT", f"/feedback/{self.REQUEST}/media/{slot}", token or self.token, data,
                         {"Content-Type": content_type, "X-Feedback-Media-Consent": consent})

    def post_media(self, manifest, token=None, **fields):
        body = {"requestId": self.REQUEST, "content": self.CONTENT, "public": True,
                "mediaConsent": True, "media": manifest, **fields}
        return self.call("POST", "/feedback", token or self.token, json.dumps(body), {"Content-Type": "application/json"})

    @staticmethod
    def recording(seconds):
        with tempfile.TemporaryDirectory() as temporary:
            dest = Path(temporary) / "fixture.mp4"
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                            "color=size=176x144:rate=4", "-f", "lavfi", "-i", "anullsrc=sample_rate=44100",
                            "-t", str(seconds), "-c:v", "libx264", "-c:a", "aac", "-metadata",
                            "title=private-source-title", str(dest)], check=True, timeout=15)
            return dest.read_bytes()

    def test_media_replay_claim_and_admin_download(self):
        folder = self.enable_media()
        self.assertTrue(self.call("GET", "/feedback/capabilities")[1]["media"]["enabled"])
        self.assertFalse(self.call("GET", "/feedback/capabilities", headers={"Host": "elsewhere.invalid"})[1]["media"]["enabled"])
        png = self.png()
        route = f"/feedback/{self.REQUEST}/media/screenshot-1"
        self.assertEqual(self.call("PUT", route, body=png)[0], 401)
        self.assertEqual(self.put_media(png, consent="false")[0], 400)
        result, staged, _ = self.put_media(png)
        self.assertEqual(result, 201)
        self.assertEqual(staged["sha256"], hashlib.sha256(png).hexdigest())
        self.assertEqual(self.put_media(png)[:2], (200, staged))
        self.assertEqual(self.put_media(self.png(color="blue"))[0], 409)
        self.assertEqual(self.put_media(png, slot="screenshot-2")[0], 201)
        self.assertEqual(self.call("DELETE", route + "2", self.token)[0], 404)
        self.assertEqual(self.call("DELETE", route[:-1] + "2", self.token)[0], 204)
        manifest = [{"slot": "screenshot-1", "sha256": staged["sha256"]}]
        self.assertEqual(self.post_media(manifest, self.admin_token)[1]["code"], "media_not_ready")
        self.assertEqual(self.post_media(manifest, content="[Feature] 增加歌词字号选项")[0], 400)
        self.assertEqual(self.post_media(manifest * 2)[0], 400)
        with mock.patch.object(cm_ai, "format_feedback", return_value=("bug", "错误", {"steps": "复现步骤"})) as ai, \
                mock.patch.object(feedback, "_create_issue", return_value=("published", 42)) as github:
            self.assertEqual(self.post_media(manifest)[0], 202)
            receipt = self.wait_for_receipt("published")
            self.assertEqual(receipt["mediaCount"], 1)
            self.assertEqual(self.post_media(manifest)[:2], (202, receipt))
            self.assertEqual(self.post_media(manifest, content=self.CONTENT + " 更改")[1]["code"], "request_conflict")
            github.assert_called_once()
            ai.assert_called_once_with(self.CONTENT)
            issue = github.call_args.args[1]
        self.assertNotIn("private-source-text", issue["body"])
        self.assertEqual(len(list(folder.iterdir())), 1)
        self.assertEqual(self.call("DELETE", route, self.token)[0], 409)
        with cm_db.connect() as conn:
            object_id, group = conn.execute("SELECT id,group_id FROM feedback_media").fetchone()
        self.assertIn("/app/#/admin?diagnostics=" + group, issue["body"])
        self.assertNotIn(object_id, issue["body"])
        download = f"/admin/feedback/media/{object_id}"
        listing = f"/admin/feedback/attachments/{group}"
        self.assertEqual(self.call("GET", listing)[0], 401)
        self.assertEqual(self.call("GET", download, self.token)[0], 403)
        self.assertEqual(self.call("GET", listing, self.admin_token)[1]["attachments"][0]["id"], object_id)
        status, saved, headers = self.call("GET", download, self.admin_token)
        self.assertEqual((status, headers["Cache-Control"]), (200, "private, no-store"))
        self.assertNotIn(b"private-source-text", saved)
        with cm_db.connect() as conn:
            now = int(time.time()) - 1
            conn.execute("UPDATE feedback_media_groups SET expires_at=?", (now,))
            conn.execute("UPDATE feedback_media SET expires_at=?", (now,))
        media.purge(feedback.EXPIRY_NOTICE)
        self.assertEqual(self.call("GET", download, self.admin_token)[0], 410)
        self.assertEqual(self.call("GET", listing, self.admin_token)[0], 410)
        self.assertFalse(list(folder.iterdir()))

    def test_media_recording_and_screenshot_with_zip(self):
        folder = self.enable_media()
        self.assertEqual(self.put_media(self.png(), slot="video-1", content_type="video/mp4")[0], 415)
        status, recorded, _ = self.put_media(self.recording(1), slot="video-1", content_type="video/mp4")
        self.assertEqual(status, 201, recorded)
        self.assertEqual(self.put_media(self.png(width=4097))[0], 422)
        self.assertEqual(self.put_media(b"\x89PNG\r\n\x1a\n")[0], 422)
        self.assertEqual(self.put_media(self.png(), content_type="image/jpeg")[0], 415)
        status, screenshot, _ = self.put_media(self.png())
        self.assertEqual(status, 201, screenshot)
        manifest = [{"slot": item["slot"], "sha256": item["sha256"]} for item in (recorded, screenshot)]
        zip_archive = self.archive()
        with mock.patch.object(cm_ai, "format_feedback", side_effect=cm_ai.AiError("offline")), \
                mock.patch.object(feedback, "_create_issue", return_value=("unconfirmed", None)) as github:
            with ThreadPoolExecutor(max_workers=2) as pool:
                replies = pool.map(lambda index: self.upload(zip_archive, token=self.token, media_fields={
                    "mediaConsent": "true", "media": json.dumps(manifest[::(-1 if index else 1)]),
                }), range(2))
                self.assertTrue(all(reply[0] == 202 for reply in replies))
            self.assertEqual(self.wait_for_receipt("unconfirmed")["mediaCount"], 2)
            issue = github.call_args.args[1]
            github.assert_called_once()
        with cm_db.connect() as conn:
            receipt = conn.execute("SELECT diagnostics_id,media_group FROM feedback_receipts WHERE request_id=?",
                                   (self.REQUEST,)).fetchone()
        self.assertEqual(receipt["diagnostics_id"], receipt["media_group"])
        self.assertEqual(issue["body"].count("/app/#/admin?diagnostics="), 1)
        items = self.call("GET", f"/admin/feedback/attachments/{receipt['media_group']}", self.admin_token)[1]["attachments"]
        self.assertEqual({item["contentType"] for item in items}, {"image/png", "video/mp4", "application/zip"})
        media.purge(feedback.EXPIRY_NOTICE)
        self.assertEqual(len(list(folder.iterdir())), 2)
        saved_video = next(folder.glob("*.mp4")).read_bytes()
        self.assertNotIn(b"private-source-title", saved_video)

    def test_media_video_only_checks_duration(self):
        self.enable_media()
        self.assertEqual(self.put_media(self.recording(31), slot="video-1", content_type="video/mp4")[0], 422)
        status, recorded, _ = self.put_media(self.recording(1), slot="video-1", content_type="video/mp4")
        self.assertEqual(status, 201)
        with mock.patch.object(cm_ai, "format_feedback", return_value=("bug", "问题", {"steps": "复现"})), \
                mock.patch.object(feedback, "_create_issue", return_value=("failed", None)) as github:
            self.assertEqual(self.post_media([{"slot": "video-1", "sha256": recorded["sha256"]}])[0], 202)
            receipt = self.wait_for_receipt("failed")
            github.assert_called_once()
        self.assertEqual(receipt["mediaCount"], 1)
        self.assertNotIn("hasDiagnostics", receipt)

    def test_media_interrupted_and_staged_expiry(self):
        folder = self.enable_media()
        png = self.png()
        connection = SimpleNamespace(headers={"Content-Length": str(len(png)), "Content-Type": "image/png",
                                               "X-Feedback-Media-Consent": "true",
                                               "Host": ":".join(map(str, self.server.server_address))}, rfile=BytesIO(png[:10]))
        with self.assertRaises(media.MediaError) as error:
            media.upload(connection, 97, self.REQUEST, "screenshot-1", feedback.RETENTION)
        self.assertEqual(error.exception.status, 400)
        self.assertFalse(list(folder.iterdir()))
        self.assertEqual(self.put_media(b"x" * (media.IMAGE_BYTES + 1))[0], 413)
        code, row, _ = self.put_media(png)
        self.assertEqual(code, 201)
        with cm_db.connect() as conn:
            conn.execute("UPDATE feedback_media SET expires_at=0")
        self.assertEqual(self.post_media([{"slot": row["slot"], "sha256": row["sha256"]}])[1]["code"], "media_not_ready")
        media.purge(feedback.EXPIRY_NOTICE)
        self.assertFalse(list(folder.iterdir()))
        self.assertEqual(self.call("GET", f"/feedback?requestId={self.REQUEST}", self.token)[0], 404)

    def test_unconfirmed_diagnostics_survive_until_expiry(self):
        with mock.patch.object(cm_ai, "format_feedback", return_value=("bug", "错误", {"steps": "复现步骤"})), \
                mock.patch.object(feedback, "_create_issue", return_value=("unconfirmed", None)) as github:
            self.assertEqual(self.upload(self.archive(), token=self.token)[0], 202)
            self.wait_for_receipt("unconfirmed")
            self.assertIn("### 截图与诊断信息\n\n[在 CurrentMusic 管理员面板下载诊断附件]",
                          github.call_args.args[1]["body"])
        with cm_db.connect() as conn:
            identifier = conn.execute("SELECT id FROM feedback_diagnostics").fetchone()[0]
        url = f"/admin/feedback/diagnostics/{identifier}"
        feedback.purge_diagnostics()
        self.assertEqual(self.call("GET", url, self.admin_token)[0], 200)
        with cm_db.connect() as conn:
            conn.execute("UPDATE feedback_diagnostics SET expires_at=?", (int(time.time()) - 1,))
        self.assertEqual(self.call("GET", url, self.admin_token)[0], 410)
        orphan = self.storage / ("b" * 32 + ".zip")
        orphan.write_bytes(b"unreferenced")
        feedback.purge_diagnostics()
        self.assertEqual(self.call("GET", url, self.admin_token)[0], 410)
        self.assertFalse(list(self.storage.iterdir()))
