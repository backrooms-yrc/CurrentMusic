"""TOTP (RFC 6238): persistent challenges, atomic replay protection and recovery codes.

Secrets stay in the private database; recovery codes and challenge tokens are hashed.
No QR/secret is sent to a third-party service.
"""
import base64
import hashlib
import hmac
import json
import re
import secrets
import struct
import time
import unicodedata
from urllib.parse import quote, urlencode

import cm_db

SCHEMA = """
CREATE TABLE IF NOT EXISTS account_2fa (
 uid INTEGER PRIMARY KEY, secret TEXT NOT NULL DEFAULT '', last_step INTEGER DEFAULT -1,
 recovery TEXT NOT NULL DEFAULT '[]', pending TEXT NOT NULL DEFAULT '',
 pending_sid TEXT NOT NULL DEFAULT '', pending_until INTEGER DEFAULT 0,
 failures INTEGER DEFAULT 0, window_start INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS account_security_questions (
 uid INTEGER PRIMARY KEY, question TEXT NOT NULL, answer_hash TEXT NOT NULL, salt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_2fa (
 hash TEXT PRIMARY KEY, uid INTEGER NOT NULL, expires INTEGER NOT NULL,
 generation TEXT NOT NULL, device TEXT NOT NULL, platform TEXT NOT NULL
);
"""


class Error(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def totp(secret, step, digits=6):
    key = base64.b32decode(secret + '=' * (-len(secret) % 8))
    mac = hmac.new(key, struct.pack('>Q', step), hashlib.sha1).digest()
    offset = mac[-1] & 15
    value = struct.unpack('>I', mac[offset:offset + 4])[0] & 0x7fffffff
    return str(value % (10 ** digits)).zfill(digits)


def match(secret, code, last=-1):
    if not re.fullmatch(r'[0-9]{6}', code):
        return None
    step = int(time.time()) // 30
    for candidate in (step, step - 1, step + 1):
        if candidate > last and hmac.compare_digest(totp(secret, candidate), code):
            return candidate
    return None


def status(uid):
    conn = cm_db.connect()
    try:
        r = conn.execute('SELECT secret,recovery FROM account_2fa WHERE uid=?', (uid,)).fetchone()
        q = question_row(conn, uid)
        return {'enabled': bool(r and r['secret']),
                'recoveryCodesRemaining': len(json.loads(r['recovery'])) if r else 0,
                'securityQuestionEnabled': bool(q),
                'securityQuestion': q['question'] if q else '',
                'verificationMethod': 'totp' if r and r['secret'] else 'security_question' if q else 'none'}
    finally:
        conn.close()


def transaction(action):
    conn = cm_db.connect()
    try:
        conn.execute('BEGIN IMMEDIATE')
        return action(conn)
    finally:
        conn.close()


def row(conn, uid):
    conn.execute('INSERT OR IGNORE INTO account_2fa(uid) VALUES(?)', (uid,))
    return dict(conn.execute('SELECT * FROM account_2fa WHERE uid=?', (uid,)).fetchone())


def limit(conn, r):
    now = int(time.time())
    if now - r['window_start'] >= 300:
        conn.execute('UPDATE account_2fa SET failures=0,window_start=? WHERE uid=?', (now, r['uid']))
    elif r['failures'] >= 5:
        conn.commit()
        raise Error('验证次数过多，请 5 分钟后重试', 429)


def fail(conn, uid, message="验证码无效、已使用或已过期"):
    conn.execute('UPDATE account_2fa SET failures=failures+1 WHERE uid=?', (uid,))
    conn.commit()
    raise Error(message, 400)


def password(conn, r, value):
    limit(conn, r)
    u = conn.execute('SELECT * FROM users WHERE id=?', (r['uid'],)).fetchone()
    if not u or u['disabled'] or not hmac.compare_digest(cm_db.hash_password(value, u['salt']), u['pass_hash']):
        fail(conn, r['uid'], '当前密码不正确')


def setup(uid, sid, value):
    def action(conn):
        r = row(conn, uid)
        password(conn, r, value)
        if question_row(conn, uid):
            raise Error('已开启登录密保问题，请先验证答案并关闭，再绑定验证器', 409)
        if r['secret']:
            raise Error('两步验证已开启，请先关闭再重新绑定')
        secret = base64.b32encode(secrets.token_bytes(20)).decode().rstrip('=')
        conn.execute('UPDATE account_2fa SET pending=?,pending_sid=?,pending_until=? WHERE uid=?',
                     (secret, digest(sid), int(time.time()) + 600, uid))
        u = conn.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone()
        conn.commit()
        label = quote('CurrentStation:' + u['username'], safe='')
        uri = 'otpauth://totp/' + label + '?' + urlencode(dict(
            secret=secret, issuer='CurrentStation', algorithm='SHA1', digits=6, period=30))
        return {'secret': secret, 'uri': uri, 'expiresIn': 600}
    return transaction(action)


def revoke_others(conn, uid, sid):
    conn.execute('UPDATE passport_grants SET revoked=1 WHERE uid=? AND sid<>?', (uid, digest(sid)))
    conn.execute('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', (uid, digest(sid)))
    conn.execute('DELETE FROM login_2fa WHERE uid=?', (uid,))


def enable(uid, sid, code):
    def action(conn):
        r = row(conn, uid)
        limit(conn, r)
        if question_row(conn, uid):
            raise Error('已开启登录密保问题，不能同时开启验证器 2FA', 409)
        if r['secret'] or not r['pending'] or r['pending_sid'] != digest(sid) or r['pending_until'] < time.time():
            raise Error('绑定已过期，请重新开始')
        step = match(r['pending'], code)
        if step is None:
            fail(conn, uid)
        codes = [secrets.token_hex(8) for _ in range(10)]
        conn.execute("UPDATE account_2fa SET secret=pending,last_step=?,recovery=?,pending='',pending_sid='',pending_until=0,failures=0 WHERE uid=?",
                     (step, json.dumps([digest(c) for c in codes]), uid))
        revoke_others(conn, uid, sid)
        conn.commit()
        return {'enabled': True, 'recoveryCodes': codes}
    return transaction(action)


def verify(conn, r, code):
    limit(conn, r)
    step = match(r['secret'], code, r['last_step']) if r['secret'] else None
    recovery = json.loads(r['recovery'])
    hashed = digest(code.replace('-', '').replace(' ', '').lower())
    if step is not None:
        conn.execute('UPDATE account_2fa SET last_step=?,failures=0 WHERE uid=?', (step, r['uid']))
    elif r['secret'] and hashed in recovery:
        recovery.remove(hashed)
        conn.execute('UPDATE account_2fa SET recovery=?,failures=0 WHERE uid=?', (json.dumps(recovery), r['uid']))
    else:
        fail(conn, r['uid'])


def disable(uid, sid, value, code):
    def action(conn):
        r = row(conn, uid)
        password(conn, r, value)
        verify(conn, r, code)
        conn.execute('DELETE FROM account_2fa WHERE uid=?', (uid,))
        revoke_others(conn, uid, sid)
        conn.commit()
        return {'enabled': False}
    return transaction(action)


def challenge(uid, device, platform):
    def action(conn):
        r = row(conn, uid)
        u = conn.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone()
        if not u or u['disabled'] or u['is_bot']:
            raise Error('账号不可登录', 403)
        q = question_row(conn, uid)
        if not r['secret'] and not q:
            token = cm_db.issue_token(uid, device, platform, _conn=conn)
            conn.commit()
            return {'token': token}
        limit(conn, r)
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        conn.execute('DELETE FROM login_2fa WHERE expires<? OR uid=?', (now, uid))
        conn.execute('INSERT INTO login_2fa VALUES(?,?,?,?,?,?)',
                     (digest(token), uid, now + 300, protection_generation(r, q), device, platform))
        conn.commit()
        result = {'requires2FA': bool(r['secret']), 'challengeToken': token, 'expiresIn': 300,
                  'requiresSecurityQuestion': bool(q) and not r['secret'],
                  'verificationMethod': 'totp' if r['secret'] else 'security_question'}
        if q and not r['secret']:
            result['securityQuestion'] = q['question']
        return result
    return transaction(action)


def complete(token, code, method="totp"):
    def action(conn):
        c = conn.execute('SELECT * FROM login_2fa WHERE hash=?', (digest(token),)).fetchone()
        if not c or c['expires'] < time.time():
            raise Error('登录验证已过期，请重新登录')
        r = row(conn, c['uid'])
        u = conn.execute('SELECT * FROM users WHERE id=?', (c['uid'],)).fetchone()
        q = question_row(conn, c['uid'])
        actual_method = 'totp' if r['secret'] else 'security_question' if q else 'none'
        if not u or u['disabled'] or u['is_bot'] or actual_method != method or c['generation'] != protection_generation(r, q):
            raise Error('登录验证已失效，请重新登录')
        if method == 'security_question':
            verify_answer(conn, r, q, code)
        else:
            verify(conn, r, code)
        conn.execute('DELETE FROM login_2fa WHERE uid=?', (c['uid'],))
        session_token = cm_db.issue_token(c['uid'], c['device'], c['platform'], _conn=conn)
        conn.commit()
        return {**dict(c), 'token': session_token}
    return transaction(action)


def question_row(conn, uid):
    return conn.execute('SELECT * FROM account_security_questions WHERE uid=?', (uid,)).fetchone()


def protection_generation(r, q):
    return digest(r['secret']) if r['secret'] else 'sq:' + digest(q['salt']) if q else ''


def normalize_answer(value):
    return unicodedata.normalize('NFKC', value).strip().casefold()


def verify_answer(conn, r, q, answer):
    limit(conn, r)
    normalized = normalize_answer(answer)
    if not q or not 2 <= len(normalized) <= 128 or not hmac.compare_digest(
            cm_db.hash_password(normalized, q['salt']), q['answer_hash']):
        fail(conn, r['uid'], '密保答案不正确，请重新输入')
    conn.execute('UPDATE account_2fa SET failures=0 WHERE uid=?', (r['uid'],))


def enable_question(uid, sid, value, question, answer):
    question = question.strip()
    normalized = normalize_answer(answer)
    if not 4 <= len(question) <= 100 or any(ord(ch) < 32 for ch in question):
        raise Error('密保问题需 4~100 个字符，不能包含换行或控制字符')
    if not 2 <= len(normalized) <= 128 or any(ord(ch) < 32 for ch in normalized):
        raise Error('密保答案需 2~128 个字符，不能包含换行或控制字符')
    def action(conn):
        r = row(conn, uid)
        password(conn, r, value)
        if r['secret']:
            raise Error('已开启验证器 2FA，请先用验证码或恢复码关闭，再设置密保问题', 409)
        if question_row(conn, uid):
            raise Error('密保问题已开启，更换问题或答案前请先验证原答案并关闭', 409)
        salt = secrets.token_hex(16)
        conn.execute('INSERT INTO account_security_questions VALUES(?,?,?,?)',
                     (uid, question, cm_db.hash_password(normalized, salt), salt))
        conn.execute("UPDATE account_2fa SET pending='',pending_sid='',pending_until=0,failures=0 WHERE uid=?", (uid,))
        revoke_others(conn, uid, sid)
        conn.commit()
        return {'enabled': True, 'question': question}
    return transaction(action)


def disable_question(uid, sid, value, answer):
    def action(conn):
        r = row(conn, uid)
        password(conn, r, value)
        q = question_row(conn, uid)
        if not q:
            raise Error('尚未开启登录密保问题')
        verify_answer(conn, r, q, answer)
        conn.execute('DELETE FROM account_security_questions WHERE uid=?', (uid,))
        revoke_others(conn, uid, sid)
        conn.commit()
        return {'enabled': False}
    return transaction(action)
