"""Import a device-local NetEase login into its authenticated project account."""
import re
import threading
import cm_db
import cm_ncm

ALLOWED_COOKIES = frozenset(('MUSIC_U', '__csrf', 'NMTID', 'MUSIC_A'))
_IMPORT_GATE = threading.BoundedSemaphore(4)
_IMPORT_TIMEOUT = object()


class BindingImportError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def import_binding(user_id, body):
    if not isinstance(body, dict):
        raise BindingImportError(400, '请求体须为 JSON 对象')
    raw = body.get('cookie')
    expected = body.get('expectedNcmUid')
    if not isinstance(expected, int) or isinstance(expected, bool) or expected <= 0:
        raise BindingImportError(400, '缺少有效的 expectedNcmUid')
    if not isinstance(raw, str) or not raw or len(raw) > 16384 or re.search(r'[^\x20-\x7e]', raw):
        raise BindingImportError(400, '网易云登录凭据格式无效')
    cookies = {}
    for part in raw.split(';'):
        if not part.strip():
            continue
        key, sep, value = part.strip().partition('=')
        if not sep or key not in ALLOWED_COOKIES or key in cookies or not value or ' ' in value:
            raise BindingImportError(400, '网易云登录凭据格式无效')
        cookies[key] = value
    if not cookies.get('MUSIC_U'):
        raise BindingImportError(400, '缺少网易云登录凭据')
    cookie = '; '.join(f'{key}={value}' for key, value in cookies.items())
    try:
        result = cm_ncm._run_with_wall_clock(
            lambda: cm_ncm.call('/user/account', cookie=cookie, timeout=8.0, retries=0),
            8.5, default=_IMPORT_TIMEOUT, gate=_IMPORT_GATE, name='cm-binding-import')
        if result is _IMPORT_TIMEOUT:
            raise TimeoutError()
    except Exception:
        # Upstream exception strings can contain a request URL and credentials.
        raise BindingImportError(502, '网易云身份验证暂时失败，请稍后重试') from None
    if not isinstance(result, dict) or not isinstance(result.get('profile'), dict):
        raise BindingImportError(401, '网易云登录凭据已失效，请重新绑定网易云账号')
    profile = result['profile']
    uid = profile.get('userId')
    if (result or {}).get('code') != 200 or not isinstance(uid, int) or isinstance(uid, bool) or uid <= 0:
        raise BindingImportError(401, '网易云登录凭据已失效，请重新绑定网易云账号')
    if uid != expected:
        raise BindingImportError(409, '网易云账号与本机登录不一致，请重新绑定后同步')
    nickname, avatar = str(profile.get('nickname') or ''), str(profile.get('avatarUrl') or '')
    cm_db.save_binding(user_id, cookie, uid, nickname, avatar)
    for prefix in ('nlikes', 'nsub'):
        cm_db.cache_delete(f'{prefix}:{user_id}')
    return {'ok': True, 'bound': True, 'profile': {'uid': uid, 'nickname': nickname, 'avatar': avatar}}
