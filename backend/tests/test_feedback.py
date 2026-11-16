import json
import os
import sys
import unittest
from io import BytesIO
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_ai
import cm_db
import cm_feedback as feedback
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
