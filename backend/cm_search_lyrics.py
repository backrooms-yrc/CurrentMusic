"""Resolve lyric-search context before returning the page, with explicit failure states.

Search snippets are evidence for locating a passage, never a substitute for its neighbours.
Shared, bounded workers fetch official lyrics; transient failures are not negative-cached.
"""
from collections import OrderedDict
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from functools import lru_cache
from opencc import OpenCC
import html
import json
import re
import threading
import time
import unicodedata

import cm_db
import cm_ncm

PAGE_TIMEOUT = 15.0
MAX_PENDING = 36
_pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix='search-lyric')
_lock = threading.Lock()
_cache = OrderedDict()
_pending = {}
_to_simplified = OpenCC('t2s')
_to_simplified.convert('繁體')  # Load immutable dictionaries before concurrent requests.


def clean(value):
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]*>', '', html.unescape(str(value or '')))).strip()


@lru_cache(maxsize=8192)
def norm(value):
    value = _to_simplified.convert(unicodedata.normalize('NFKC', clean(value)))
    return ''.join(c for c in value.casefold() if c.isalnum())


def snippet(song):
    raw = song.get('lyrics') or song.get('lyric') or ''
    if isinstance(raw, dict):
        raw = raw.get('txt') or raw.get('lyric') or ''
    values = raw if isinstance(raw, list) else [raw]
    values = [x for x in values if isinstance(x, str) and clean(x)]
    highlighted = [x for x in values if re.search(r'<(?:b|em)(?:\s[^>]*)?>', x, re.I)]
    return clean((highlighted or values or [''])[0])[:1000]


def _parse_document(raw):
    if not isinstance(raw, str):
        return []
    raw = raw[:200000]
    parsed = cm_ncm._parse_lines(raw)
    if parsed:
        return [(t, clean(txt)[:1000]) for t, txt, *_ in parsed if clean(txt)][:2000]
    # Untimed full lyrics still have real line adjacency. Do not treat LRC metadata as lyrics.
    return [(None, clean(line)[:1000]) for line in raw.splitlines()
            if clean(line) and not re.match(r'^\[|^\{', line.strip())][:2000]


def _cached_documents(song_id):
    try:
        raw = cm_db.cache_get(f'lyric:{cm_ncm.LYRIC_CACHE_VERSION}:{song_id}')
        data = json.loads(raw) if raw else {}
        if isinstance(data, dict) and isinstance(data.get('lines'), list):
            lines = [(line.get('t'), clean(line.get('txt'))[:1000])
                     for line in data['lines'] if isinstance(line, dict) and clean(line.get('txt'))]
            if lines:
                return [dict(source='currentmusic:cache', lines=lines[:2000])]
    except (ValueError, TypeError):
        pass
    return []


def _fetch(song_id, source):
    key = (song_id, source)
    try:
        path = '/lyric/new' if source == 'new' else '/lyric'
        # Retry a transient failure here, within the original search request.
        data = cm_ncm.call(path, {'id': song_id}, timeout=2.0, retries=1)
        if not isinstance(data, dict) or data.get('code', 200) != 200:
            raise ValueError('invalid lyric response')
        documents = []
        for field in ('lrc', 'yrc', 'tlyric', 'romalrc'):
            track = data.get(field)
            lines = _parse_document(track.get('lyric')) if isinstance(track, dict) else []
            if lines:
                documents.append(dict(source=f'netease:{source}:{field}', lines=lines))
        # A bare/empty 200 response can be a transient upstream failure, not proof of absence.
        status = 'ready' if documents else ('missing' if data.get('nolyric') is True or data.get('uncollected') is True else 'error')
        result = dict(status=status, documents=documents)
    except Exception:
        result = dict(status='error', documents=[])
    with _lock:
        # Do not poison subsequent requests with a cached timeout/network failure.
        if result['status'] != 'error':
            _cache[key] = (time.monotonic() + (3600 if result['documents'] else 60), result)
            _cache.move_to_end(key)
            while len(_cache) > 1024:
                _cache.popitem(last=False)
        _pending.pop(key, None)
    return result


def _lookup(song_id, source):
    key = (song_id, source)
    with _lock:
        cached = _cache.get(key)
        if cached and cached[0] > time.monotonic():
            _cache.move_to_end(key)
            return cached[1], None
        job = _pending.get(key)
        if not job and len(_pending) < MAX_PENDING:
            # _fetch takes this lock before returning, so assignment always precedes completion.
            job = _pool.submit(_fetch, song_id, source)
            _pending[key] = job
        return None, job


def context(lines, match, keyword):
    """Locate a real contiguous passage, including snippets spanning several lyric lines."""
    normalized = [norm(txt) for _, txt in lines]
    target, query = norm(match), norm(keyword)
    needles = [target] if target else []
    if query and query != target and (len(query) >= 2 or not target):
        needles.append(query)
    for needle in needles:
        # Exact full-line evidence has priority over excerpt/keyword matches.
        exact = next((i for i, text in enumerate(normalized) if text == needle), None)
        spans = [(exact, exact)] if exact is not None else []
        if not spans:
            for start in range(len(lines)):
                joined = ''
                for end in range(start, min(start + 5, len(lines))):
                    joined += normalized[end]
                    if needle in joined:
                        # Do not include an irrelevant preceding line in the matched passage.
                        while start < end and needle in ''.join(normalized[start+1:end+1]):
                            start += 1
                        spans.append((start, end))
                        break
                if spans:
                    break
        if spans:
            start, end = spans[0]
            return [dict(t=lines[j][0], txt=lines[j][1], matched=start <= j <= end)
                    for j in range(max(0, start-1), min(len(lines), end+2))]
    return []


def enrich(raw_songs, songs, keyword):
    """Finish queued lookups and fallback within this request; never label a snippet as context."""
    deadline = time.monotonic() + PAGE_TIMEOUT
    groups = {}
    for raw, song in zip(raw_songs, songs):
        song.update(lyric='', lyricMatch=snippet(raw), lyricContext=[], lyricContextComplete=False)
        song_id = song.get('ncm_id')
        if isinstance(song_id, int) and song_id > 0:
            groups.setdefault(song_id, []).append(song)
    unresolved = set(groups)
    attempts = {song_id: [] for song_id in groups}

    def apply(song_id, documents):
        for song in groups[song_id]:
            if song['lyricContextComplete']:
                continue
            best, source = [], ''
            for document in documents:
                found = context(document['lines'], song['lyricMatch'], keyword)
                if len(found) > len(best):
                    best, source = found, document['source']
                if len(found) >= 2:
                    break
            if best:
                song['lyricContext'] = best
                song['lyricMatch'] = ' '.join(x['txt'] for x in best if x['matched'])
                song['lyricContextSource'] = source
                if len(best) >= 2:
                    song['lyric'] = ' · '.join(x['txt'] for x in best)
                    song['lyricContextComplete'] = True
        if all(s['lyricContextComplete'] for s in groups[song_id]):
            unresolved.discard(song_id)

    for song_id in list(unresolved):
        apply(song_id, _cached_documents(song_id))
    # Resolve in result order; a failed/unmatched item can try classic immediately,
    # rather than waiting for an unrelated slow item to consume the page deadline.
    todo = [(song_id, 'new') for song_id in groups if song_id in unresolved]
    active = {}

    def accept(song_id, source, result):
        attempts[song_id].append(result['status'])
        apply(song_id, result['documents'])
        if song_id in unresolved and source == 'new':
            todo.append((song_id, 'classic'))

    while (todo or active) and time.monotonic() < deadline:
        progressed = False
        for song_id, source in list(todo):
            result, job = _lookup(song_id, source)
            if result is not None:
                todo.remove((song_id, source)); accept(song_id, source, result)
                progressed = True
            elif job is not None:
                active[(song_id, source)] = job; todo.remove((song_id, source))
                progressed = True
        for (song_id, source), job in list(active.items()):
            if job.done():
                del active[(song_id, source)]; accept(song_id, source, job.result())
                progressed = True
        if todo and progressed:
            continue
        if todo or active:
            jobs = list(active.values())
            if not jobs:
                with _lock:
                    jobs = list(_pending.values())
            if not jobs:
                break
            wait(jobs, timeout=max(0, deadline-time.monotonic()), return_when=FIRST_COMPLETED)
    for song_id, _ in todo + list(active):
        attempts[song_id].append('pending')

    messages = {
        'pending': '歌词前后文仍在获取，请重试',
        'error': '歌词前后文获取失败，请重试',
        'missing': '此歌曲暂无可用的完整歌词',
        'unmatched': '完整歌词中未能定位搜索命中句',
        'single_line': '完整歌词仅含一句，没有可显示的前后文',
    }
    for song_id, entries in groups.items():
        for song in entries:
            if song['lyricContextComplete']:
                status = 'complete'
            elif song['lyricContext']:
                status = 'single_line'
            else:
                states = attempts[song_id]
                status = next((s for s in ('pending', 'error', 'ready') if s in states), 'missing')
                if status == 'ready':
                    status = 'unmatched'
            song['lyricContextStatus'] = status
            song['lyricContextRetryable'] = status in ('pending', 'error')
            if status != 'complete':
                # Legacy clients display lyric directly: make the failure visible, not a fake preview.
                song['lyric'] = messages[status]
    for song in songs:
        if 'lyricContextStatus' not in song:
            song.update(lyricContextStatus='missing', lyricContextRetryable=False, lyric=messages['missing'])
    return songs
