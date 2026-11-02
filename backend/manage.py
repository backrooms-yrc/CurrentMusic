#!/usr/bin/env python3
"""CurrentMusic 后端运维 CLI（自托管/开源部署用）。

用法：
    python3 backend/manage.py init-db
    python3 backend/manage.py create-owner admin --nickname 管理员
    python3 backend/manage.py create-owner admin --password 'your-password'
    python3 backend/manage.py reset-password admin
    python3 backend/manage.py show-config

数据库路径由 CM_DB 决定（默认 <repo>/data/cm.db）。此脚本不依赖 HTTP 服务。
"""
from __future__ import annotations

import argparse
import os
import re
import secrets
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cm_db  # noqa: E402


def _password(value: str | None, label: str) -> str:
    if value:
        if len(value) < 6:
            raise SystemExit("密码至少 6 位")
        return value
    value = secrets.token_urlsafe(12)
    print(f"已生成{label}密码（只显示一次，请立即保存）：{value}")
    return value


def _set_password(uid: int, password: str) -> None:
    salt = secrets.token_hex(8)
    h = cm_db.hash_password(password, salt)
    conn = cm_db.connect()
    try:
        conn.execute("UPDATE users SET pass_hash=?, salt=?, token_hash='' WHERE id=?", (h, salt, int(uid)))
        conn.execute("DELETE FROM sessions WHERE user_id=?", (int(uid),))
        conn.commit()
    finally:
        conn.close()


def cmd_create_owner(args) -> None:
    cm_db.init()
    username = args.username.strip()
    if not re.fullmatch(r"[A-Za-z0-9_\u4e00-\u9fff]{2,24}", username):
        raise SystemExit("用户名需 2~24 位字母/数字/下划线/中文")
    u = cm_db.get_user_by_name(username)
    if u:
        if args.password:
            _set_password(u["id"], _password(args.password, "新"))
        if args.nickname:
            conn = cm_db.connect()
            try:
                conn.execute("UPDATE users SET nickname=? WHERE id=?", (args.nickname[:24], u["id"]))
                conn.commit()
            finally:
                conn.close()
        uid = u["id"]
        print(f"账号已存在，直接提升（uid={uid}）" + ("" if args.password else "；密码未改动"))
    else:
        password = _password(args.password, "初始")
        uid = cm_db.create_user(username, password, args.nickname or username)
        print(f"已创建账号 {username}（uid={uid}）")
    cm_db.set_owner(uid, True)
    print("已设为站长（同时拥有超级管理员/管理员权限）。")


def cmd_reset_password(args) -> None:
    u = cm_db.get_user_by_name(args.username.strip())
    if not u:
        raise SystemExit("用户不存在")
    _set_password(u["id"], _password(args.password, "新"))
    print(f"已重置 {args.username} 的密码，并注销其全部会话。")


def cmd_init_db(_args) -> None:
    cm_db.init()
    print(f"数据库已初始化：{cm_db.DB_PATH}")


def cmd_show_config(_args) -> None:
    env = os.environ
    print(f"DB:            {cm_db.DB_PATH}")
    print(f"data dir:      {os.path.dirname(cm_db.DB_PATH)}")
    try:
        import cm_ncm
        print(f"NCM API:       {cm_ncm.BASE}")
        print(f"NCM cookie:    {cm_ncm.COOKIE_PATH}（{'存在' if os.path.isfile(cm_ncm.COOKIE_PATH) else '未找到'}）")
    except Exception as e:  # noqa: BLE001
        print(f"NCM:           配置读取失败: {e}")
    print(f"listen:        127.0.0.1:{env.get('CM_PORT', '3010')}")
    print(f"default host:  {env.get('CM_DEFAULT_HOST', 'localhost')}")
    print(f"AI key:        {'已配置' if env.get('CM_AI_KEY', '').strip() else '未配置（AI 功能降级）'}")
    print(f"SMTP:          {'已配置' if env.get('CM_SMTP_USER') else '未配置'}")
    print(f"SMS webhook:   {'已配置' if env.get('CM_SMS_WEBHOOK') else '未配置'}")


def main() -> None:
    ap = argparse.ArgumentParser(description="CurrentMusic backend maintenance")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("init-db", help="初始化/迁移数据库")
    p.set_defaults(func=cmd_init_db)

    p = sub.add_parser("create-owner", help="创建（或提升）站长账号")
    p.add_argument("username")
    p.add_argument("--nickname", default="")
    p.add_argument("--password", default="", help="不填则随机生成并打印一次")
    p.set_defaults(func=cmd_create_owner)

    p = sub.add_parser("reset-password", help="重置账号密码并注销其会话")
    p.add_argument("username")
    p.add_argument("--password", default="", help="不填则随机生成并打印一次")
    p.set_defaults(func=cmd_reset_password)

    p = sub.add_parser("show-config", help="显示解析后的关键配置（不输出密钥）")
    p.set_defaults(func=cmd_show_config)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
