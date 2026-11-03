"""Best-effort lyric search context. Never infer adjacency from search snippets.

Official lyrics only: no LDDC fan-out, bounded shared workers/pending jobs and page deadline.
A slow lookup can warm the cache after the search response has already fallen back.
"""
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, wait
import html
import re
import threading
import time
import unicodedata

import cm_ncm

PAGE_TIMEOUT = 2.5
MAX_PENDING = 36
_pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix='search-lyric')
_lock = threading.Lock()
_cache = OrderedDict()
_pending = {}


def clean(value):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]*>', '', str(value or '')))).strip()


def norm(value):
    return ''.join(c for c in unicodedata.normalize('NFKC', clean(value)).casefold() if c.isalnum())


def snippet(song):
    raw = song.get('lyrics') or song.get('lyric') or ''
    if isinstance(raw, dict):
        raw = raw.get('txt') or raw.get('lyric') or ''
    values = raw if isinstance(raw, list) else [raw]
    values = [x for x in values if isinstance(x, str) and clean(x)]
    highlighted = [x for x in values if re.search(r'<(?:b|em)(?:\s[^>]*)?>', x, re.I)]
    return clean((highlighted or values or [''])[0])[:1000]


def _fetch(song_id):
    try:
        data = cm_ncm.call('/lyric/new', {'id': song_id}, timeout=2.0, retries=0)
        raw = ((data or {}).get('lrc') or {}).get('lyric') or ((data or {}).get('yrc') or {}).get('lyric') or ''
        lines = [(t, clean(txt)) for t, txt, *_ in cm_ncm._parse_lines(raw[:200000]) if clean(txt)][:2000]
    except Exception:
        lines = []
    with _lock:
        _cache[song_id] = (time.monotonic() + (3600 if lines else 30), lines)
        _cache.move_to_end(song_id)
        while len(_cache) > 1024:
            _cache.popitem(last=False)
        _pending.pop(song_id, None)
    return lines


def _lookup(song_id):
    with _lock:
        cached = _cache.get(song_id)
        if cached and cached[0] > time.monotonic():
            _cache.move_to_end(song_id)
            return cached[1], None
        job = _pending.get(song_id)
        if not job and len(_pending) < MAX_PENDING:
            # _fetch acquires this lock before returning, so it cannot finish before assignment.
            job = _pool.submit(_fetch, song_id)
            _pending[song_id] = job
        return [], job


def context(lines, match, keyword):
    target, query = norm(match), norm(keyword)
    candidates = [i for i, (_, txt) in enumerate(lines) if target and norm(txt) == target]
    if not candidates:
        candidates = [i for i, (_, txt) in enumerate(lines) if query and query in norm(txt)]
    if not candidates:
        return []
    i = candidates[0]
    return [dict(t=lines[j][0], txt=lines[j][1], matched=j == i)
            for j in range(max(0, i-1), min(len(lines), i+2))]


def enrich(raw_songs, songs, keyword):
    """Preserve songs/order/paging and the legacy lyric string; add structured context."""
    lookups = {}
    for raw, song in zip(raw_songs, songs):
        song['lyric'] = snippet(raw)
        song['lyricMatch'] = song['lyric']
        song['lyricContext'] = []
        song['lyricContextComplete'] = False
        song_id = song.get('ncm_id')
        if isinstance(song_id, int) and song_id > 0 and song_id not in lookups:
            lookups[song_id] = _lookup(song_id)
    jobs = [job for _, job in lookups.values() if job]
    if jobs:
        wait(jobs, timeout=PAGE_TIMEOUT)
    for song in songs:
        lines, job = lookups.get(song.get('ncm_id'), ([], None))
        if job and job.done():
            lines = job.result()
        found = context(lines, song['lyric'], keyword)
        if found:
            song['lyricContext'] = found
            song['lyricMatch'] = next(x['txt'] for x in found if x['matched'])
            song['lyric'] = ' · '.join(x['txt'] for x in found)
            song['lyricContextComplete'] = True
    return songs
