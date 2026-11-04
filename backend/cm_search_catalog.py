"""Exact matches from explicitly indexed public NetEase album metadata, never user libraries."""
import json
import os
from pathlib import Path
import re
import threading
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
PATH = Path(os.environ.get('CM_SEARCH_CATALOG', str(Path(os.environ.get('CM_DATA_DIR', str(ROOT / 'data'))) / 'search-catalog.json')))
_lock = threading.Lock()
_stamp = None
_songs = []


def revision():
    try:
        return PATH.stat().st_mtime_ns
    except OSError:
        return 0


def _normalized(text):
    return re.sub(r'[^\w]', '', unicodedata.normalize('NFKC', str(text or '')).casefold())


def find(keywords, exclude=(), limit=10):
    global _stamp, _songs
    stamp = revision()
    with _lock:
        if stamp != _stamp:
            try:
                if PATH.stat().st_size > 20 * 1024 * 1024:
                    raise ValueError('catalog too large')
                data = json.loads(PATH.read_text())
                _songs = data['songs'] if data.get('version') == 1 and isinstance(data.get('songs'), list) else []
            except (OSError, ValueError, KeyError, TypeError, AttributeError):
                _songs = []
            _stamp = stamp
        songs = _songs
    query = _normalized(keywords)
    excluded = {str(x) for x in exclude}
    hits = []
    for song in songs:
        if not isinstance(song, dict) or str(song.get('ncm_id')) in excluded:
            continue
        try:
            ident = int(song.get('ncm_id'))
        except (TypeError, ValueError):
            continue
        if ident <= 0:
            continue
        name = _normalized(song.get('name'))
        if not name:
            continue
        artists = [_normalized(x) for x in str(song.get('artists') or '').split(' / ')]
        if query == name or any(artist and query in (artist + name, name + artist) for artist in artists):
            hits.append(dict(song, catalogSource='netease-album'))
    hits.sort(key=lambda s: (_normalized(s.get('album')) != _normalized(s.get('name')), int(s.get('ncm_id') or 0)))
    return hits[:limit]
