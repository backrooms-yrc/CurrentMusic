#!/usr/bin/env python3
"""Exercise the local gateway with independent Windows test accounts and a temporary DB."""

import argparse
import json
import os
import secrets
import sys
from contextlib import closing, redirect_stdout
from http.server import ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[3]


def exercise(base, accounts):
    def call(path, body=None, token=None, expected=200):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        payload = json.dumps(body).encode() if body is not None else None
        try:
            reply = urlopen(Request(base + path, data=payload, headers=headers), timeout=8)
        except HTTPError as error:
            reply = error
        with reply:
            if reply.status != expected:
                raise RuntimeError(f"{path}: got HTTP {reply.status}, expected {expected}")
            return json.load(reply)

    capability = call("/plays/capabilities")
    if capability.get("clientPlayId") is not True:
        raise RuntimeError("Gateway did not advertise idempotent play starts")
    tokens = []
    for username, password, uid in accounts:
        login = call(
            "/auth/login",
            {"username": username, "password": password, "device": "Windows QA", "platform": "windows"},
        )
        token = login["token"]
        if call("/auth/me", token=token)["id"] != uid:
            raise RuntimeError("Unexpected account for session")
        tokens.append(token)

    body = {
        "clientPlayId": "local-gateway-test",
        "platform": "windows",
        "name": "QA track",
        "duration": 120000,
    }
    play_id = call("/plays/1", body, tokens[0])["playId"]
    if call("/plays/1", body, tokens[0])["playId"] != play_id:
        raise RuntimeError("Repeated play start returned a different ID")
    call("/plays/2", body, tokens[0], expected=409)
    if call("/plays/1", body, tokens[1])["playId"] == play_id:
        raise RuntimeError("Play ID was shared across accounts")
    call("/plays/1", {"playId": play_id, "totalMs": 3000}, tokens[1], expected=404)
    call("/plays/1", {"playId": play_id, "totalMs": 3000, "finished": True}, tokens[0])
    print("Local gateway passed capability, login, play idempotency and account isolation checks")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture-stdio", action="store_true",
                        help="Expose disposable accounts to the native integration test over stdio")
    args = parser.parse_args()
    with TemporaryDirectory(prefix="cm-windows-parity-") as data:
        os.environ["CM_DATA_DIR"] = data
        os.environ["CM_DB"] = str(Path(data) / "test.db")
        sys.path.insert(0, str(ROOT / "backend"))
        import cm_db
        import cm_server

        with redirect_stdout(sys.stderr):
            cm_db.init()
            with closing(cm_db.connect()) as connection:
                cm_server.cm_rooms.init_room_tables(connection)
                cm_server.cm_chat.init_chat_tables(connection)
                cm_server.cm_region.init_region_tables(connection)
            accounts = []
            for username in ("windows-qa-a", "windows-qa-b"):
                password = secrets.token_urlsafe(24)
                uid = cm_db.create_user(username, password, username)
                accounts.append((username, password, uid))

        with ThreadingHTTPServer(("127.0.0.1", 0), cm_server.Handler) as server:
            worker = Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                base = f"http://127.0.0.1:{server.server_port}"
                if args.fixture_stdio:
                    print(json.dumps({"base": base, "accounts": [
                        {"username": name, "password": password, "id": uid}
                        for name, password, uid in accounts
                    ]}), flush=True)
                    sys.stdin.read()
                else:
                    exercise(base, accounts)
            finally:
                server.shutdown()
                worker.join()


if __name__ == "__main__":
    main()
