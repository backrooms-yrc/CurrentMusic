#!/usr/bin/env python3
"""Register the independently published Android client in the selected engine DB."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import cm_db
import cm_music_service
import cm_passport


def main():
    key = cm_music_service.DEFAULT_CLIENT_ID
    callback = cm_music_service.X_CALLBACK
    scopes = " ".join(("openid", "offline_access", *cm_passport.MUSIC_SCOPES))
    existing = cm_db.passport_app_get(key)
    if existing is not None:
        if existing["disabled"] or existing["secret_hash"] or json.loads(existing["redirects"]) != [callback]:
            raise SystemExit("现有客户端配置与预期不同，请在开发者平台核对")
        print(key)
        return
    cm_db.passport_app_create(key, "流声音乐", "", [callback], scopes,
                              homepage="https://currentmusicx.bileizhen.top")
    print(key)


if __name__ == "__main__":
    main()
