import http.client
import json
import os
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

    def upload(self, archive, content=None, consent="true", token=None, public="true"):
        boundary = "TestFeedbackBoundary"
        body = []
        for name, value in {"requestId": self.REQUEST, "content": content or self.CONTENT,
                            "public": public, "diagnosticsConsent": consent}.items():
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
