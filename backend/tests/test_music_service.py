"""Music service contract tests with a throwaway account and fixture upstream."""
import base64
import hashlib
import json
import os
import time
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import test_password_reset as harness
import cm_db
import cm_music_service as service
import cm_ncm
import cm_passport
import cm_server


class MusicServiceTests(unittest.TestCase):
    setUp = harness.TestPasswordReset.setUp
    _cleanup = harness.TestPasswordReset._cleanup

    def call(self, method, path, body=None, bearer="", host="provider.example.test"):
        request = harness._Handler(method, path, body=body, token=bearer)
        request.headers.update({"Host": host, "X-Forwarded-Proto": "https"})
        headers = {}
        request.send_header = headers.__setitem__
        cm_server.Handler._dispatch(request, method)
        raw = request.wfile.getvalue()
        data = raw.decode() if headers["Content-Type"].startswith("text/html") else json.loads(raw)
        return request.status, data, headers

    def account(self, scopes, uid=None, title="fixture-user"):
        user = uid or cm_db.create_user(title, "tester-password", title)
        app = service.DEFAULT_CLIENT_ID
        if not cm_db.passport_app_get(app):
            cm_db.passport_app_create(app, "播放器样例", "", [service.X_CALLBACK],
                                      "openid offline_access " + " ".join(cm_passport.MUSIC_SCOPES))
        access = cm_passport.new_token("at")
        cm_db.passport_grant_create(cm_passport.new_grant_id(), app, user, scopes,
                                    cm_passport.hash_token(access), "", int(time.time()) + 3600, 0)
        return user, access

    def operation(self, name, data=None, bearer="", confirm=False, provider="netease"):
        status, response, headers = self.call("POST", f"/music-service/v1/{name}",
                                             {"provider": provider, "input": data or {}, "confirm": confirm}, bearer)
        self.assertEqual(headers.get("Cache-Control"), "no-store")
        return status, response

    def test_descriptor_and_connection_are_public_without_credentials(self):
        self.account("openid")
        with patch.dict(os.environ, {service.MEDIA_ENV: ""}):
            status, profile, hdr = self.call("GET", "/music-service/descriptor")
        self.assertEqual((status, hdr["Cache-Control"]), (200, "no-store"))
        self.assertEqual(profile["format"], "currentmusic.music-service")
        self.assertEqual(profile["apiBase"], "https://provider.example.test/cm/music-service/v1")
        self.assertEqual(profile["authorization"]["issuer"], "https://provider.example.test/cm")
        ids = {row["id"] for row in profile["platforms"]["netease"]}
        self.assertTrue({"catalog.search", "library.playlists", "history.record", "roaming.songs"} <= ids)
        self.assertNotIn("playback.resolve", ids)
        self.assertNotIn("access_token", json.dumps(profile))
        status, html, _ = self.call("GET", "/music-service/connect")
        self.assertEqual(status, 200)
        self.assertIn("descriptor=https%3A%2F%2Fprovider.example.test", html)

    def test_public_catalog_normalization_and_provider_isolation(self):
        result = {"songs": [{"ncm_id": 42, "name": "Fixture", "pic": "https://assets.example.test/item",
                              "duration": 82_000, "mv": 12}], "hasMore": {"song": True}}
        with patch.object(cm_ncm, "search_types", return_value=result) as upstream:
            status, page = self.operation("catalog.search", {"query": "fixture", "limit": 1})
        self.assertEqual(status, 200)
        self.assertEqual((page["items"][0]["id"], page["items"][0]["videoId"], page["items"][0]["durationMs"]),
                         ("42", "12", 82_000))
        self.assertEqual(page["nextOffset"], 1)
        self.assertEqual(upstream.call_args.args[:2], ("fixture", ("song",)))
        self.assertEqual(self.operation("auth.me")[0], 404)
        self.assertEqual(self.operation("library.playlists", provider="qqmusic")[0], 404)

    def test_playback_uses_personal_binding_and_preserves_refusal(self):
        uid, token = self.account("openid music.play")
        with patch.dict(os.environ, {service.MEDIA_ENV: "playback"}):
            self.assertEqual(self.operation("playback.resolve", {"id": "12"}, bearer=cm_db.issue_token(uid))[0], 401)
            self.assertEqual(self.operation("playback.resolve", {"id": "12"}, bearer=token)[1]["code"], "binding_required")
            upstream = {"code": 200, "data": [{"id": 12, "code": 200, "url": "https://media.example.test/fixture",
                                              "freeTrialInfo": {"start": 0}, "level": "standard"}]}
            with patch.object(cm_db, "get_binding", return_value={"cookie": "fixture", "stale": False}), \
                 patch.object(cm_ncm, "call", return_value=upstream) as official, \
                 patch.object(cm_server, "resolve_play_url") as legacy:
                self.assertEqual(self.operation("playback.resolve", {"id": "12"}, bearer=token)[1]["code"],
                                 "playback_unavailable")
                upstream["data"][0]["freeTrialInfo"] = None
                status, data = self.operation("playback.resolve", {"id": "12", "quality": "standard"}, bearer=token)
                self.assertEqual((status, data["quality"]), (200, "standard"))
                self.assertEqual(official.call_args.kwargs["cookie"], "fixture")
                legacy.assert_not_called()
            self.assertEqual(self.operation("playback.download", {"id": "12"}, bearer=token)[0], 404)

    def test_account_scope_confirmation_ownership_and_revocation(self):
        uid, reader = self.account("openid music.library.read")
        _, writer = self.account("openid music.library.write", uid)
        other, _ = self.account("openid music.library.write", title="other-fixture")
        private = cm_db.create_playlist(other, "Other owner's playlist")
        self.assertEqual(self.operation("library.playlist.create", {"name": "Fixture"}, reader, True)[0], 403)
        self.assertEqual(self.operation("library.playlist.create", {"name": "Fixture"}, writer)[0], 400)
        self.assertEqual(self.operation("library.playlist.delete", {"id": str(private)}, writer, True)[0], 404)
        status, body = self.operation("library.playlist.create", {"name": "Fixture"}, writer, True)
        self.assertEqual((status, body["resource"]["name"]), (200, "Fixture"))
        self.assertEqual(self.operation("library.playlists", bearer=reader)[1]["items"][0]["name"], "Fixture")
        self.assertEqual(self.call("GET", "/playlists", bearer=reader)[0], 401)
        cm_db.passport_grant_revoke(uid=uid)
        self.assertEqual(self.operation("library.playlists", bearer=reader)[0], 401)

    def test_music_consent_requires_s256_and_includes_issuer(self):
        uid, _ = self.account("openid")
        session = cm_db.issue_token(uid)
        params = {"approve": True, "scope": "openid music.library.read",
                  "client_id": service.DEFAULT_CLIENT_ID, "redirect_uri": service.X_CALLBACK, "state": "fixture-state",
                  "code_challenge": "a" * 44, "code_challenge_method": "plain"}
        self.assertEqual(self.call("POST", "/passport/authorize", params, session)[0], 400)
        verifier = "k" * 48
        params.update(code_challenge_method="S256", code_challenge=base64.urlsafe_b64encode(
            hashlib.sha256(verifier.encode()).digest()).decode().rstrip("="))
        status, response, _ = self.call("POST", "/passport/authorize", params, session)
        self.assertEqual(status, 200)
        args = parse_qs(urlsplit(response["redirect"]).query)
        self.assertEqual(args["iss"], ["https://provider.example.test/cm"])
        self.assertEqual(args["state"], ["fixture-state"])
        body = {"grant_type": "authorization_code", "client_id": service.DEFAULT_CLIENT_ID,
                "redirect_uri": service.X_CALLBACK, "code_verifier": verifier, "code": args["code"][0]}
        status, grant, hdr = self.call("POST", "/passport/token", body)
        self.assertEqual((status, hdr["Cache-Control"]), (200, "no-store"))
        self.assertEqual(self.operation("library.playlists", bearer=grant["access_token"])[0], 200)
        self.assertEqual(self.call("POST", "/passport/token", body)[0], 400)
        self.assertEqual(self.call("POST", "/passport/apps",
                         {"name": "Fixture", "redirects": [service.X_CALLBACK], "scopes": "music.play"}, session)[0], 403)
