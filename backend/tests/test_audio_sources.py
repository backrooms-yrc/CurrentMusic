"""Native source catalog and playback contract, exercised against a temporary DB."""
import json
import unittest
from unittest import mock

import test_password_reset as harness
from cm_server import Handler, PlaybackMatchError
import cm_db
import cm_server


CATALOG = "/audio-sources"
RESOLVE = CATALOG + "/currentmusic-engine/resolve"


class AudioSourceTests(unittest.TestCase):
    setUp = harness.TestPasswordReset.setUp
    _cleanup = harness.TestPasswordReset._cleanup

    def get(self, path, token=""):
        handler = harness._Handler("GET", path, token=token)
        headers = {}
        handler.send_header = headers.__setitem__
        Handler._dispatch(handler, "GET")
        self.assertEqual(headers["Cache-Control"], "no-store")
        return handler.status, json.loads(handler.wfile.getvalue())

    def account(self):
        uid = cm_db.create_user("source-fixture", "fixture-password", "Fixture")
        return cm_db.issue_token(uid), cm_db.lx_token_issue(uid)

    def test_catalog_and_resolver_require_a_session_header(self):
        token, lx_token = self.account()
        for path in (CATALOG, RESOLVE + "?id=123"):
            self.assertEqual(self.get(path)[0], 401)
            self.assertEqual(self.get(path, lx_token)[0], 401)
            self.assertEqual(self.get(path + ("&" if "?" in path else "?") + "token=" + token)[0], 401)

        self.assertEqual(self.get(CATALOG, token), (200, {
            "version": 1,
            "sources": [{"id": "currentmusic-engine", "name": "流声引擎", "platforms": ["netease"]}],
        }))
        self.assertEqual(self.get(CATALOG + "/unknown/resolve?id=123", token)[0], 404)

    def test_resolver_uses_existing_playback_policy(self):
        token, _ = self.account()
        audio = {"url": "https://audio.example.test/song.flac", "level": "lossless", "type": "flac"}
        with mock.patch.object(cm_server, "resolve_play_url", return_value=audio) as resolve:
            self.assertEqual(self.get(RESOLVE + "?id=bad", token)[0], 400)
            self.assertEqual(self.get(RESOLVE + "?id=123&refresh=1&supportsDolby=1&cn=1", token), (200, audio))
            self.assertEqual(resolve.call_args.args, (123, "auto"))
            self.assertTrue(resolve.call_args.kwargs["refresh"])
            self.assertTrue(resolve.call_args.kwargs["supports_dolby"])
            self.assertFalse(resolve.call_args.kwargs["cn_ip"])
        with mock.patch.object(cm_server, "resolve_play_url", side_effect=PlaybackMatchError("fixture")):
            self.assertEqual(self.get(RESOLVE + "?id=123&level=lossless", token),
                             (502, {"error": "fixture", "code": "playback_match_failed"}))
