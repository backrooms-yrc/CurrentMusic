"""WebAuthn passkeys: UV required; persistent, single-use, origin/session-bound ceremonies."""
import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from urllib.parse import urlparse

import cm_db
import cm_2fa
from webauthn import (generate_registration_options, generate_authentication_options,
                      verify_registration_response, verify_authentication_response, options_to_json)
from webauthn.helpers.structs import (AuthenticatorSelectionCriteria, ResidentKeyRequirement,
                                      UserVerificationRequirement, PublicKeyCredentialDescriptor)

DEFAULT_ORIGINS = {'https://' + h for h in ('music.20110208.xyz', 'music.ctcehs.com',
            'currentmusic.geekertao.com', 'cm.bileizhen.top')}


def configured_origins(value=None):
    if value is None:
        value = os.environ.get('CM_PASSKEY_ORIGINS')
    if value is None:
        return set(DEFAULT_ORIGINS)
    origins = {part.strip() for part in value.split(',') if part.strip()}
    if not origins:
        raise ValueError('CM_PASSKEY_ORIGINS must contain explicit HTTPS origins')
    for origin in origins:
        parsed = urlparse(origin)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
                or parsed.path or parsed.params or parsed.query or parsed.fragment
                or '*' in origin or any(c.isspace() for c in origin)
                or origin != 'https://' + parsed.netloc):
            raise ValueError('CM_PASSKEY_ORIGINS must contain explicit HTTPS origins')
        parsed.port  # Validate port syntax/range too.
    return origins


ORIGINS = configured_origins()
SCHEMA = '''
CREATE TABLE IF NOT EXISTS passkey_users(uid INTEGER PRIMARY KEY, handle BLOB NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS passkeys(id TEXT PRIMARY KEY,uid INTEGER NOT NULL,rp TEXT NOT NULL,
 public_key BLOB NOT NULL,counter INTEGER NOT NULL,name TEXT NOT NULL,created INTEGER NOT NULL,last_used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS passkey_challenges(id TEXT PRIMARY KEY,kind TEXT NOT NULL,uid INTEGER,
 sid TEXT NOT NULL,origin TEXT NOT NULL,challenge BLOB NOT NULL,expires INTEGER NOT NULL);
'''
Error = cm_2fa.Error

def b64(value):
    return base64.urlsafe_b64encode(value).decode().rstrip('=')

def connect():
    c = cm_db.connect()
    c.executescript(SCHEMA)
    return c

def origin_check(origin):
    if origin not in ORIGINS:
        raise Error('请在受支持的 HTTPS 网页入口使用通行密钥', 403)
    return urlparse(origin).hostname

def authorize(uid, password, factor):
    def action(c):
        r = cm_2fa.row(c, uid)
        cm_2fa.password(c, r, password)
        q = cm_2fa.question_row(c, uid)
        if q:
            cm_2fa.verify_answer(c, r, q, factor)
        elif r['secret']:
            step = cm_2fa.match(r['secret'], factor)
            if step is None or step <= r['last_step']:
                cm_2fa.fail(c, uid)
            c.execute('UPDATE account_2fa SET last_step=? WHERE uid=?', (step, uid))
        c.commit()
    cm_2fa.transaction(action)

def listing(uid):
    c = connect()
    try:
        return {'keys': [dict(r) for r in c.execute('SELECT id,rp,name,created,last_used FROM passkeys WHERE uid=? ORDER BY created', (uid,))]}
    finally:
        c.close()

def begin(origin, uid=None, sid='', password='', factor='', name=''):
    rp = origin_check(origin)
    if uid is not None:
        authorize(uid, password, factor)
    c = connect()
    try:
        c.execute('BEGIN IMMEDIATE')
        now = int(time.time())
        c.execute('DELETE FROM passkey_challenges WHERE expires<?', (now,))
        if c.execute('SELECT count(*) FROM passkey_challenges').fetchone()[0] >= 2000:
            raise Error('请求繁忙，请稍后重试', 429)
        if uid is not None:
            if c.execute('SELECT count(*) FROM passkeys WHERE uid=?', (uid,)).fetchone()[0] >= 20:
                raise Error('最多绑定 20 个通行密钥')
            c.execute('INSERT OR IGNORE INTO passkey_users VALUES(?,?)', (uid, secrets.token_bytes(32)))
            handle = bytes(c.execute('SELECT handle FROM passkey_users WHERE uid=?', (uid,)).fetchone()[0])
            u = cm_db.get_user(uid)
            opts = generate_registration_options(rp_id=rp, rp_name='CurrentMusic', user_id=handle,
                user_name=u['username'], user_display_name=u['nickname'] or u['username'],
                authenticator_selection=AuthenticatorSelectionCriteria(resident_key=ResidentKeyRequirement.REQUIRED,
                    user_verification=UserVerificationRequirement.REQUIRED),
                exclude_credentials=[PublicKeyCredentialDescriptor(id=base64.urlsafe_b64decode(r[0]+'='*(-len(r[0])%4)))
                    for r in c.execute('SELECT id FROM passkeys WHERE uid=? AND rp=?', (uid,rp))])
        else:
            opts = generate_authentication_options(rp_id=rp, user_verification=UserVerificationRequirement.REQUIRED)
        ident = secrets.token_urlsafe(32)
        c.execute('INSERT INTO passkey_challenges VALUES(?,?,?,?,?,?,?)',
            (hashlib.sha256(ident.encode()).hexdigest(), 'register' if uid else 'login', uid,
             hashlib.sha256(sid.encode()).hexdigest(), origin, opts.challenge, now+300))
        c.commit()
        return {'challengeToken': ident, 'publicKey': json.loads(options_to_json(opts))}
    finally:
        c.close()

def finish(origin, ident, credential, uid=None, sid='', name='', device='', platform=''):
    rp = origin_check(origin)
    c = connect()
    try:
        c.execute('BEGIN IMMEDIATE')
        key = hashlib.sha256(ident.encode()).hexdigest()
        row = c.execute('SELECT * FROM passkey_challenges WHERE id=?', (key,)).fetchone()
        if not row or row['expires'] < time.time() or row['origin'] != origin or row['uid'] != uid or row['kind'] != ('register' if uid else 'login') or row['sid'] != hashlib.sha256(sid.encode()).hexdigest():
            raise Error('通行密钥请求已过期或不匹配，请重新开始')
        # Consume before signature validation, including failed attempts.
        c.execute('DELETE FROM passkey_challenges WHERE id=?', (key,)); c.commit()
        c.execute('BEGIN IMMEDIATE')
        try:
            if uid is not None:
                result = verify_registration_response(credential=credential, expected_challenge=bytes(row['challenge']),
                    expected_origin=origin, expected_rp_id=rp, require_user_verification=True)
                if c.execute('SELECT count(*) FROM passkeys WHERE uid=?',(uid,)).fetchone()[0] >= 20:
                    raise ValueError('key limit')
                c.execute('INSERT INTO passkeys(id,uid,rp,public_key,counter,name,created) VALUES(?,?,?,?,?,?,?)',
                    (b64(result.credential_id), uid, rp, result.credential_public_key, result.sign_count,
                     str(name).strip()[:64] or '通行密钥', int(time.time())))
                c.commit()
                return {'ok': True}
            stored = c.execute('SELECT * FROM passkeys WHERE id=? AND rp=?', (credential.get('id'),rp)).fetchone()
            if not stored:
                raise ValueError('unknown credential')
            u = c.execute('SELECT * FROM users WHERE id=?', (stored['uid'],)).fetchone()
            handle = c.execute('SELECT handle FROM passkey_users WHERE uid=?', (stored['uid'],)).fetchone()
            if not u or u['disabled'] or not handle or not hmac.compare_digest(str((credential.get('response') or {}).get('userHandle') or ''), b64(bytes(handle[0]))):
                raise ValueError('user mismatch')
            result = verify_authentication_response(credential=credential, expected_challenge=bytes(row['challenge']),
                expected_origin=origin, expected_rp_id=rp, credential_public_key=bytes(stored['public_key']),
                credential_current_sign_count=stored['counter'], require_user_verification=True)
            c.execute('UPDATE passkeys SET counter=?,last_used=? WHERE id=?', (result.new_sign_count,int(time.time()),stored['id']))
            token = cm_db.issue_token(stored['uid'],device,platform,_conn=c)
            c.commit()
            return {'token': token, 'uid': stored['uid']}
        except Exception:
            c.rollback()
            raise Error('通行密钥验证失败，请重试或使用其他登录方式', 400)
    finally:
        c.close()

def remove(uid, key, password, factor):
    authorize(uid,password,factor)
    c = connect()
    try:
        c.execute('DELETE FROM passkeys WHERE uid=? AND id=?', (uid,key)); c.commit()
        return {'ok': True}
    finally:
        c.close()
