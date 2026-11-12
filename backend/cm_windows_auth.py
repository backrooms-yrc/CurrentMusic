"""Browser passkey ceremony and one-time Windows session exchange."""

import base64
import hashlib
import hmac
import json
import re
import secrets
import time

import cm_db
import cm_passkeys

Error = cm_passkeys.Error
URL_TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
CALLBACK = re.compile(r"http://127\.0\.0\.1:([1-9][0-9]{0,4})/currentmusic/auth")


def validated_flow(origin, values):
    if origin not in cm_passkeys.ORIGINS:
        raise Error("请使用支持通行密钥的 HTTPS 线路", 403)
    if not isinstance(values, dict):
        raise Error("无效的 Windows 登录请求")
    redirect, state, challenge = (values.get(key) for key in ("redirectUri", "state", "codeChallenge"))
    match = CALLBACK.fullmatch(redirect) if isinstance(redirect, str) else None
    if (not match or not 1024 <= int(match[1]) <= 65535
            or not isinstance(state, str) or not URL_TOKEN.fullmatch(state)
            or not isinstance(challenge, str) or not URL_TOKEN.fullmatch(challenge)):
        raise Error("无效的 Windows 登录请求")
    flow = hashlib.sha256((redirect + "\n" + state + "\n" + challenge).encode()).hexdigest()
    return flow, challenge


def begin(origin, values):
    flow, _ = validated_flow(origin, values)
    return cm_passkeys.begin(origin, sid="windows:" + flow)


def finish(origin, values):
    flow, challenge = validated_flow(origin, values)
    ident, credential = values.get("challengeToken"), values.get("credential")
    if not isinstance(ident, str) or not URL_TOKEN.fullmatch(ident) or not isinstance(credential, dict):
        raise Error("无效的通行密钥响应")
    return cm_passkeys.finish(origin, ident, credential, sid="windows:" + flow,
                              windows_flow=(flow, challenge))


def exchange(values):
    if not isinstance(values, dict):
        raise Error("无效的 Windows 登录请求")
    origin, code, verifier = (values.get(key) for key in ("origin", "code", "codeVerifier"))
    if (not isinstance(origin, str) or not isinstance(code, str) or not URL_TOKEN.fullmatch(code)
            or not isinstance(verifier, str) or not URL_TOKEN.fullmatch(verifier)):
        raise Error("无效的 Windows 登录凭据")
    challenge = cm_passkeys.b64(hashlib.sha256(verifier.encode()).digest())
    flow, _ = validated_flow(origin, dict(values, codeChallenge=challenge))
    db = cm_passkeys.connect()
    try:
        with db:
            db.execute("BEGIN IMMEDIATE")
            key = hashlib.sha256(code.encode()).hexdigest()
            row = db.execute("SELECT * FROM windows_passkey_codes WHERE id=?", (key,)).fetchone()
            if (not row or row["expires"] <= time.time() or row["origin"] != origin
                    or not hmac.compare_digest(row["flow"], flow)
                    or not hmac.compare_digest(row["challenge"], challenge)):
                raise Error("Windows 登录授权码无效或已过期")
            user = db.execute("SELECT disabled FROM users WHERE id=?", (row["uid"],)).fetchone()
            if not user or user["disabled"]:
                raise Error("账号不可用", 403)
            db.execute("DELETE FROM windows_passkey_codes WHERE id=?", (key,))
            return {"uid": row["uid"], "token": cm_db.issue_token(
                row["uid"], "CurrentMusic Windows", "windows", _conn=db)}
    finally:
        db.close()


def request_enrollment(user, values):
    if not isinstance(values, dict):
        raise Error("无效的通行密钥绑定请求")
    origin = values.get("origin")
    if not isinstance(origin, str) or origin not in cm_passkeys.ORIGINS:
        raise Error("请使用支持通行密钥的 HTTPS 线路", 403)
    ticket = secrets.token_urlsafe(32)
    uid = user["id"]
    session_hash = hashlib.sha256(user["_token"].encode()).hexdigest()
    options = cm_passkeys.begin(origin, uid, ticket, str(values.get("password") or ""),
                               str(values.get("factor") or ""))
    db = cm_passkeys.connect()
    try:
        with db:
            db.execute("BEGIN IMMEDIATE")
            if not cm_passkeys.active_session(db, uid, session_hash):
                raise Error("会话已失效", 401)
            now = int(time.time())
            db.execute("DELETE FROM windows_passkey_enrollments WHERE expires<=? OR session_hash=?",
                       (now, session_hash))
            db.execute("INSERT INTO windows_passkey_enrollments VALUES(?,?,?,?,?,?,?)",
                       (hashlib.sha256(ticket.encode()).hexdigest(), uid, origin, session_hash,
                        json.dumps(options), str(values.get("name") or "")[:64], now + options["expiresIn"]))
            return {"ticket": ticket}
    finally:
        db.close()


def enrollment(origin, values, verify=False):
    if origin not in cm_passkeys.ORIGINS or not isinstance(values, dict):
        raise Error("无效的通行密钥绑定请求")
    ticket = values.get("ticket")
    if not isinstance(ticket, str) or not URL_TOKEN.fullmatch(ticket):
        raise Error("绑定请求无效或已过期")
    key = hashlib.sha256(ticket.encode()).hexdigest()
    db = cm_passkeys.connect()
    try:
        row = db.execute("SELECT * FROM windows_passkey_enrollments WHERE id=?", (key,)).fetchone()
        if (not row or row["expires"] <= time.time() or row["origin"] != origin
                or not cm_passkeys.active_session(db, row["uid"], row["session_hash"])):
            raise Error("绑定请求无效或已过期")
        options = json.loads(row["options"])
        if not verify:
            return {"publicKey": options["publicKey"]}
        credential = values.get("credential")
        if not isinstance(credential, dict):
            raise Error("无效的通行密钥响应")
        return cm_passkeys.finish(origin, options["challengeToken"], credential, row["uid"], ticket,
                                  row["name"], active_session_hash=row["session_hash"])
    finally:
        db.close()


SCRIPT = """'use strict';
const button = document.querySelector('button');
const status = document.querySelector('[role=status]');
const params = new URLSearchParams(location.search);
const fields = Object.fromEntries(['redirectUri', 'state', 'codeChallenge'].map(k => [k, params.get(k)]));
const enroll = location.pathname.endsWith('/enroll');
const ticket = location.hash.slice(1);
if (enroll) history.replaceState(null, '', location.pathname);
const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const encode = value => value == null ? null : btoa(String.fromCharCode(...new Uint8Array(value)))
  .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
async function post(action, body) {
  const url = new URL(action, location.href);
  const response = await fetch(url.pathname, {
    method: 'POST', cache: 'no-store', credentials: 'omit',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('Authorization failed');
  return response.json();
}
button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    if (enroll) {
      const { publicKey } = await post('enroll/options', { ticket });
      publicKey.challenge = decode(publicKey.challenge);
      publicKey.user.id = decode(publicKey.user.id);
      for (const item of publicKey.excludeCredentials || []) item.id = decode(item.id);
      const created = await navigator.credentials.create({ publicKey });
      const credential = created.toJSON ? created.toJSON() : {
        id: created.id, rawId: encode(created.rawId), type: created.type,
        response: {
          clientDataJSON: encode(created.response.clientDataJSON),
          attestationObject: encode(created.response.attestationObject),
        },
        clientExtensionResults: created.getClientExtensionResults(),
      };
      await post('enroll/verify', { ticket, credential });
      status.textContent = '通行密钥已绑定。返回 CurrentMusic 并刷新密钥列表。';
      return;
    }
    const redirect = new URL(fields.redirectUri);
    if (!/^http:\\/\\/127\\.0\\.0\\.1:[1-9][0-9]{0,4}\\/currentmusic\\/auth$/.test(fields.redirectUri)) {
      throw new Error('Invalid callback');
    }
    const { challengeToken, publicKey } = await post('options', fields);
    publicKey.challenge = decode(publicKey.challenge);
    if (publicKey.allowCredentials) {
      for (const item of publicKey.allowCredentials) item.id = decode(item.id);
    }
    const signed = await navigator.credentials.get({ publicKey });
    const credential = signed.toJSON ? signed.toJSON() : {
      id: signed.id, rawId: encode(signed.rawId), type: signed.type,
      response: Object.fromEntries(['clientDataJSON', 'authenticatorData', 'signature', 'userHandle']
        .map(key => [key, encode(signed.response[key])])),
      clientExtensionResults: signed.getClientExtensionResults(),
    };
    const { code } = await post('verify', { ...fields, challengeToken, credential });
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error('Invalid authorization code');
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', fields.state);
    location.replace(redirect.href);
  } catch (_) {
    status.textContent = '未完成通行密钥验证，请重试或返回 CurrentMusic。';
    button.disabled = false;
  }
});"""

SCRIPT_HASH = base64.b64encode(hashlib.sha256(SCRIPT.encode()).digest()).decode()
HTML = f"""<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta name="referrer" content="no-referrer">
<title>CurrentMusic Windows 登录</title>
<h1>登录 CurrentMusic Windows</h1>
<p>使用本网站已有的通行密钥授权桌面客户端登录。</p>
<button type="button">使用通行密钥</button><p role="status"></p>
<script>{SCRIPT}</script></html>"""

ENROLL_HTML = HTML.replace("登录 CurrentMusic Windows", "绑定 CurrentMusic 通行密钥").replace(
    "使用本网站已有的通行密钥授权桌面客户端登录。", "为当前 CurrentMusic 账号创建通行密钥。"
).replace(">使用通行密钥</button>", ">创建通行密钥</button>")
