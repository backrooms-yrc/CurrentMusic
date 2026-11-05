#!/usr/bin/env python3
"""Index public album metadata for selected artists; writes only to the ignored runtime directory."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import ipaddress
import json
import os
from pathlib import Path
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
import cm_ncm
import cm_search_catalog


def update(artists, destination, real_ip=None):
    albums = set()
    for artist in artists:
        for offset in range(0, 1000, 100):
            data = cm_ncm.call('/artist/album', {'id': artist, 'limit': 100, 'offset': offset},
                               with_cookie=False, real_ip=real_ip)
            batch = data.get('hotAlbums') or []
            albums.update(int(a['id']) for a in batch if a.get('id'))
            if not data.get('more') or not batch:
                break

    def fetch(ident):
        data = cm_ncm.call('/album', {'id': ident}, with_cookie=False, real_ip=real_ip)
        return [cm_ncm._norm_song(s) for s in data.get('songs') or [] if s.get('id')]

    songs = {}
    if destination.exists():
        previous = json.loads(destination.read_text())
        songs = {s['ncm_id']: s for s in previous.get('songs', []) if s.get('ncm_id')}
    # Complete all reads first: an upstream failure never replaces the existing catalog.
    with ThreadPoolExecutor(max_workers=4) as pool:
        for batch in pool.map(fetch, sorted(albums)):
            songs.update((s['ncm_id'], s) for s in batch)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=destination.parent, delete=False) as staged:
        try:
            json.dump({'version': 1, 'updatedAt': int(time.time()), 'songs': list(songs.values())}, staged, ensure_ascii=False)
            staged.close()
            os.chmod(staged.name, 0o644)
            os.replace(staged.name, destination)
        finally:
            if os.path.exists(staged.name):
                os.unlink(staged.name)
    return len(albums), len(songs)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artist', type=int, action='append', required=True)
    parser.add_argument('--output', type=Path, default=cm_search_catalog.PATH)
    parser.add_argument('--real-ip', type=lambda s: str(ipaddress.ip_address(s)))
    args = parser.parse_args()
    if any(ident <= 0 for ident in args.artist):
        parser.error('artist IDs must be positive')
    albums, songs = update(args.artist, args.output, args.real_ip)
    print(f'Public album catalog updated: {albums} albums, {songs} songs')
