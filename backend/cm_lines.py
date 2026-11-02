"""固定线路目录与有限并发、短时缓存的服务端 HTTPS 探测。"""
import copy
import json
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, wait

LINES = (
    ('main', '主站', 'https://music.20110208.xyz'),
    ('ctcehs', 'CTCEHS 镜像', 'https://music.ctcehs.com'),
    ('geekertao', 'Geekertao 镜像', 'https://currentmusic.geekertao.com'),
    ('bileizhen', 'Bileizhen 镜像', 'https://cm.bileizhen.top'),
)
TTL = 60
TIMEOUT = 4
_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix='line-probe')
_slots = threading.BoundedSemaphore(4)
_lock = threading.Lock()
_cache = None
_expires = 0


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def catalog():
    return [dict(id=key, name=name, origin=origin, appUrl=origin + '/app/',
                 probeUrl=origin + '/cm/network/probe') for key, name, origin in LINES]


def probe(url):
    start = time.monotonic()
    status, code = 'error', None
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        req = urllib.request.Request(url + '?t=' + str(time.time_ns()),
                                     headers={'Accept': 'application/json', 'Cache-Control': 'no-cache'})
        with opener.open(req, timeout=TIMEOUT) as response:
            code = response.status
            payload = response.read(4097)
        data = json.loads(payload) if len(payload) <= 4096 else {}
        if data.get('service') == 'CurrentMusic' and data.get('ok') is True:
            status = 'ok' if code == 200 else 'http_error'
        else:
            status = 'invalid_response'
    except urllib.error.HTTPError as error:
        code, status = error.code, 'http_error'
        error.close()
    except (TimeoutError, OSError):
        status = 'unreachable'
    except Exception:
        status = 'invalid_response'
    return dict(status=status, available=status == 'ok', httpStatus=code,
                latencyMs=round((time.monotonic() - start) * 1000, 1))


def snapshot(measure=True):
    global _cache, _expires
    if not measure:
        return dict(perspective='server', measuredAt=None, cacheTtlSeconds=TTL,
                    cached=False, measuring=False, lines=catalog())
    # 并发访问复用缓存；不排队等待其他探测，避免公开测速拖住 API 线程。
    if not _lock.acquire(blocking=False):
        result = copy.deepcopy(_cache) if _cache else snapshot(False)
        result.update(cached=bool(_cache), measuring=True)
        return result
    try:
        if _cache is not None and time.monotonic() < _expires:
            result = copy.deepcopy(_cache)
            result['cached'] = True
            return result
        lines = catalog()
        jobs = {}
        for line in lines:
            if _slots.acquire(blocking=False):
                try:
                    job = _pool.submit(probe, line['probeUrl'])
                except Exception:
                    _slots.release()
                    raise
                job.add_done_callback(lambda _: _slots.release())
                jobs[job] = line
            else:
                line['result'] = dict(status='busy', available=False, httpStatus=None, latencyMs=None)
        done, pending = wait(jobs, timeout=TIMEOUT + 1)
        for job in done:
            jobs[job]['result'] = job.result()
        for job in pending:
            jobs[job]['result'] = dict(status='timeout', available=False, httpStatus=None, latencyMs=None)
        _cache = dict(perspective='server', measuredAt=int(time.time()), cacheTtlSeconds=TTL,
                      cached=False, measuring=False, lines=lines)
        _expires = time.monotonic() + TTL
        return copy.deepcopy(_cache)
    finally:
        _lock.release()
