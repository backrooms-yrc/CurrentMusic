#!/usr/bin/env python3
"""CurrentMusicAI 的逻辑、流式回退和管理接口测试。

    tools/run-tests.sh -p test_ai.py -v
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_ai as A  # noqa: E402
import cm_db  # noqa: E402
import cm_server  # noqa: E402


class TestCardText(unittest.TestCase):
    def test_song(self):
        t = A.card_text([{"type": "song", "id": 3340114785, "name": "Reply",
                          "sub": "kz / かぐや"}])
        self.assertIn("类型：单曲", t)
        self.assertIn("名称：Reply", t)
        self.assertIn("歌手：kz / かぐや", t)
        self.assertIn("ID：3340114785", t)

    def test_playlist(self):
        t = A.card_text([{"type": "playlist", "id": 9, "name": "测试歌单", "sub": "12 首"}])
        self.assertIn("类型：歌单", t)
        self.assertIn("信息：12 首", t)

    def test_empty(self):
        self.assertEqual(A.card_text([]), "")

    def test_user_turn_optional_card(self):
        self.assertEqual(A.user_turn("", "推荐点歌"), "推荐点歌")
        self.assertIn("卡片信息", A.user_turn("类型：单曲", "背景？"))
        self.assertIn("问题：背景？", A.user_turn("类型：单曲", "背景？"))
        self.assertIn("图片", A.user_turn("", "", has_image=True))
        self.assertIn("图片", A.user_turn("", "", has_image=True))

    def test_clear_command(self):
        self.assertTrue(A.is_clear_command("清除上下文"))
        self.assertTrue(A.is_clear_command(" /reset "))
        self.assertFalse(A.is_clear_command("这首歌的背景"))


class TestCards(unittest.TestCase):
    HITS = [
        {"type": "album", "id": 1, "name": "叶惠美", "sub": "周杰伦", "pic": "a.jpg"},
        {"type": "album", "id": 2, "name": "叶惠美", "sub": "张三", "pic": "b.jpg"},
        {"type": "song", "id": 3, "name": "晴天", "sub": "Jay", "pic": "c.jpg"},
    ]

    def test_fallback_single_name(self):
        out = A._fallback_cards("推荐《晴天》，附上卡片。", [], self.HITS)
        self.assertEqual([c["id"] for c in out], [3])

    def test_fallback_ambiguous_name_needs_artist(self):
        self.assertEqual(A._fallback_cards("推荐《叶惠美》。", [], self.HITS), [])
        out = A._fallback_cards("推荐周杰伦的《叶惠美》。", [], self.HITS)
        self.assertEqual([c["id"] for c in out], [1])

    def test_fallback_does_not_duplicate_model_card(self):
        card = dict(self.HITS[2])
        out = A._fallback_cards("推荐《晴天》。", [card], self.HITS)
        self.assertEqual(len(out), 1)

    def test_attach_rejects_unknown_id(self):
        cards = []
        msg = A._attach_card({"type": "song", "id": 999, "name": "编造"}, cards, self.HITS, [])
        self.assertIn("只能附加", msg)
        self.assertEqual(cards, [])

    def test_attach_uses_source_fields_and_dedupes_name(self):
        cards = []
        msg = A._attach_card({"type": "album", "id": 1, "name": "伪造名",
                              "sub": "伪造歌手"}, cards, self.HITS, [])
        self.assertEqual(msg, "已附加")
        self.assertEqual(cards[0]["name"], "叶惠美")
        self.assertEqual(cards[0]["sub"], "周杰伦")
        msg = A._attach_card({"type": "album", "id": 2, "name": "叶惠美"}, cards, self.HITS, [])
        self.assertIn("同名", msg)
        self.assertEqual(len(cards), 1)

    def test_attach_accepts_quoted_card(self):
        cards = []
        quote = {"type": "song", "id": 77, "name": "Reply", "sub": "kz", "pic": ""}
        msg = A._attach_card({"type": "song", "id": 77}, cards, [], [quote])
        self.assertEqual(msg, "已附加")
        self.assertEqual(cards[0]["name"], "Reply")


class TestImageMessage(unittest.TestCase):
    def test_text_only_content(self):
        m = A.user_message("", "你好")
        self.assertEqual(m, {"role": "user", "content": "你好"})

    def test_multimodal_content(self):
        url = "data:image/jpeg;base64,AAAA"
        m = A.user_message("", "图里是什么？", url)
        self.assertEqual(m["role"], "user")
        self.assertIsInstance(m["content"], list)
        self.assertEqual(m["content"][0], {"type": "text", "text": "图里是什么？"})
        self.assertEqual(m["content"][1],
                         {"type": "image_url", "image_url": {"url": url}})

    def test_image_default_prompt(self):
        m = A.user_message("", "", "data:image/jpeg;base64,AAAA")
        self.assertIn("图片", m["content"][0]["text"])

    def test_image_data_url_resizes(self):
        try:
            from PIL import Image
        except Exception:
            self.skipTest("Pillow 未安装")
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            fp = f.name
        try:
            Image.new("RGB", (1600, 800), (200, 30, 40)).save(fp, "PNG")
            with mock.patch.object(A.cm_chat, "image_path", return_value=fp):
                url = A._image_data_url("ignored.png")
            self.assertTrue(url.startswith("data:image/jpeg;base64,"))
            import base64, io as _io
            raw = base64.b64decode(url.split(",", 1)[1])
            im = Image.open(_io.BytesIO(raw))
            self.assertLessEqual(max(im.size), A.AI_IMAGE_SIDE)
        finally:
            os.unlink(fp)

    def test_image_missing_returns_empty(self):
        self.assertEqual(A._image_data_url("does-not-exist.jpg"), "")

    def test_dsml_noise_is_removed(self):
        raw = ("<｜｜DSML｜｜ calls>\n"
               "<｜｜DSML｜｜ invoke name=\"attach_card\">\n"
               "真正的回答在这里。\n"
               "</｜｜DSML｜｜ invoke>")
        self.assertTrue(A._has_dsml(raw))
        out = A._sanitize_dsml(raw)
        self.assertEqual(out, "真正的回答在这里。")
        self.assertFalse(A._has_dsml(out))


class TestQuestionAndTrim(unittest.TestCase):
    def test_clean_question_removes_bot(self):
        self.assertEqual(A.clean_question("@CurrentMusicAI 这首歌的创作背景？"),
                         "这首歌的创作背景？")
        self.assertEqual(A.clean_question("@ CurrentMusicAI  你好"), "你好")

    def test_trim_by_sentence(self):
        text = "第一句。" * 200
        out = A.trim_answer(text, limit=50)
        self.assertLessEqual(len(out), 51)
        self.assertTrue(out.endswith("…"))
        self.assertTrue(out.startswith("第一句。"))

    def test_trim_keeps_short(self):
        self.assertEqual(A.trim_answer("短回答。"), "短回答。")


def _stream(*deltas, finish="stop", done=True):
    events = [{"choices": [{"delta": delta}]} for delta in deltas]
    if finish:
        events.append({"choices": [{"finish_reason": finish, "delta": {}}]})
    lines = [f"data: {json.dumps(event)}\n\n" for event in events]
    if done:
        lines.append("data: [DONE]\n\n")
    return io.BytesIO("".join(lines).encode())


class TestModelRouting(unittest.TestCase):
    SONG = {"type": "song", "id": 77, "name": "Reply", "sub": "kz", "pic": ""}

    def setUp(self):
        tmp = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(mock.patch.object(cm_db, "DB_PATH", os.path.join(tmp, "test.db")))
        self.enterContext(mock.patch.dict(os.environ, {"CM_AI_ZAI_KEY": "test-primary",
                                                       "CM_AI_KEY": "test-fallback"}))
        cm_db.init()
        A._init_history()

    def mock_streams(self, *responses):
        return self.enterContext(mock.patch.object(A.urllib.request, "urlopen", side_effect=responses))

    def tool_round(self):
        return _stream({"reasoning_content": "internal only"},
                       {"tool_calls": [{"index": 0, "id": "call_1", "function": {
                           "name": "attach_card", "arguments": '{"id":77,'}}]},
                       {"tool_calls": [{"index": 0, "function": {"arguments": '"type":"song"}'}}]},
                       finish="tool_calls")

    def test_primary_stream_preserves_tool_reasoning_without_exposing_it(self):
        upstream = self.mock_streams(self.tool_round(), _stream({"content": "这是 Reply。"}))
        visible = []
        text, cards = A.answer_player(1, "请附卡", [self.SONG], on_text=visible.append)
        self.assertEqual((text, cards), ("这是 Reply。", [self.SONG]))
        self.assertEqual(visible, [text])
        first, second = [c.args[0] for c in upstream.call_args_list]
        self.assertEqual(first.full_url, A.ZAI_BASE + "/chat/completions")
        self.assertEqual(first.get_header("Authorization"), "Bearer test-primary")
        payload = json.loads(first.data)
        self.assertEqual(payload["model"], "glm-5.3-flash")
        self.assertEqual(payload["reasoning_effort"], "max")
        self.assertEqual(payload["thinking"], {"type": "enabled", "clear_thinking": False})
        self.assertTrue(payload["tool_stream"])
        messages = json.loads(second.data)["messages"]
        self.assertEqual(messages[-2]["reasoning_content"], "internal only")
        self.assertEqual(messages[-1]["tool_call_id"], "call_1")
        self.assertEqual(len(A.load_history(1, "player")), 2)
        self.assertEqual(A.load_history(1), [])
        self.assertNotIn("internal only", repr(A.load_history(1, "player")))

    def test_broken_primary_stream_clears_partial_text_cards_and_tool_trace(self):
        upstream = self.mock_streams(self.tool_round(),
                                     _stream({"content": "主模型半句话"}, finish=None, done=False),
                                     _stream({"content": "备用回答"}))
        visible = []
        image = "data:image/jpeg;base64,AAAA"
        text, cards = A._answer_stream("问题", "", 1, visible.append, [self.SONG], image)
        self.assertEqual((text, cards), ("备用回答", []))
        self.assertEqual(visible, ["主模型半句话", "", "备用回答"])
        req = upstream.call_args.args[0]
        payload = json.loads(req.data)
        self.assertEqual(req.full_url, A.API_BASE + "/chat/completions")
        self.assertEqual(req.get_header("Authorization"), "Bearer test-fallback")
        self.assertEqual(payload["model"], A.MODEL)
        self.assertEqual([message["role"] for message in payload["messages"]], ["system", "user"])
        self.assertEqual(payload["messages"][-1]["content"][-1]["image_url"]["url"], image)
        history = A.load_history(1)
        self.assertEqual(len(history), 2)
        self.assertEqual(history[-1]["content"], text)
        self.assertNotIn(image, repr(history))

    def test_http_rate_limit_timeout_and_empty_primary_use_fallback(self):
        for primary in (urllib.error.HTTPError(A.ZAI_BASE, 429, "", {}, None),
                        TimeoutError(), _stream({"reasoning_content": "only reasoning"})):
            with self.subTest(type=type(primary).__name__), mock.patch.object(
                    A.urllib.request, "urlopen", side_effect=(primary, _stream({"content": "备用回答"}))) as upstream:
                self.assertEqual(A.answer_player(1, "问题", [self.SONG])[0], "备用回答")
                self.assertEqual(upstream.call_count, 2)

    def test_disabled_primary_uses_legacy_model_directly(self):
        cm_db.set_ai_settings(False, "low")
        upstream = self.mock_streams(_stream({"content": "原模型"}))
        self.assertEqual(A.answer_player(1, "问题", [self.SONG])[0], "原模型")
        upstream.assert_called_once()
        self.assertEqual(upstream.call_args.args[0].full_url, A.API_BASE + "/chat/completions")

    def test_disconnected_client_does_not_retry_the_model(self):
        upstream = self.mock_streams(_stream({"content": "正文"}))
        with self.assertRaises(BrokenPipeError):
            A.answer_player(1, "问题", [self.SONG], on_text=mock.Mock(side_effect=BrokenPipeError))
        upstream.assert_called_once()
        self.assertEqual(A.load_history(1, "player"), [])


class TestAdminAi(unittest.TestCase):
    def setUp(self):
        tmp = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(mock.patch.object(cm_db, "DB_PATH", os.path.join(tmp, "test.db")))
        self.enterContext(mock.patch.dict(os.environ, {"CM_AI_ZAI_KEY": "test-primary",
                                                       "CM_AI_KEY": "test-fallback"}))
        cm_db.init()
        uid = cm_db.create_user("ai_admin", "password123", "AI Admin")
        cm_db.set_admin(uid, True)
        self.admin = cm_db.issue_token(uid)
        self.normal = cm_db.issue_token(cm_db.create_user("ai_user", "password123", "User"))

    def call(self, method, path, token, body=None):
        encoded = json.dumps(body).encode() if body is not None else b""
        handler = SimpleNamespace(path=path, rfile=io.BytesIO(encoded), client_address=("127.0.0.1", 0),
                                  headers={"Authorization": "Bearer " + token,
                                           "Content-Length": str(len(encoded))})
        with mock.patch.object(cm_server, "jresp") as response:
            try:
                cm_server.route(handler, method)
            except cm_server.ApiError as e:
                return e.code, {"error": e.msg}
        return response.call_args.args[1:3]

    def test_admin_settings_saved_and_credentials_never_returned(self):
        status, response = self.call("GET", "/admin/ai", self.admin)
        self.assertEqual(status, 200)
        self.assertEqual(response["primary"], {"model": "glm-5.3-flash", "effort": "max",
                                               "enabled": True, "configured": True})
        status, response = self.call("POST", "/admin/ai", self.admin, {"enabled": False, "effort": "low"})
        self.assertEqual(status, 200)
        self.assertEqual(self.call("GET", "/admin/ai", self.admin), (200, response))
        self.assertEqual(cm_db.get_ai_settings(), (False, "low"))
        self.assertNotIn("test-primary", repr(response))
        self.assertNotIn("test-fallback", repr(response))
        self.assertEqual(self.call("POST", "/admin/ai", self.admin, {"enabled": "false", "effort": "max"})[0], 400)
        self.assertEqual(self.call("POST", "/admin/ai", self.admin, {"enabled": True, "effort": "none"})[0], 400)

    def test_admin_probe_tests_only_selected_provider(self):
        with mock.patch.object(A.urllib.request, "urlopen", side_effect=TimeoutError) as upstream:
            status, response = self.call("POST", "/admin/ai/test", self.admin, {"provider": "zai"})
        self.assertEqual(status, 200)
        self.assertFalse(response["ok"])
        self.assertIn("超时", response["error"])
        upstream.assert_called_once()
        self.assertEqual(upstream.call_args.args[0].full_url, A.ZAI_BASE + "/chat/completions")

    def test_non_admin_cannot_read_modify_or_probe(self):
        for method, path in (("GET", "/admin/ai"), ("POST", "/admin/ai"), ("POST", "/admin/ai/test")):
            with self.subTest(method=method, path=path):
                self.assertEqual(self.call(method, path, self.normal)[0], 403)
                self.assertEqual(self.call(method, path, "")[0], 401)


if __name__ == "__main__":
    unittest.main()
