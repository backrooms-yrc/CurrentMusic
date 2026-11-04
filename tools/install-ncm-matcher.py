#!/usr/bin/env python3
"""Install reproducible CurrentMusic matcher hooks; keep upstream source backups in ignored runtime data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MARKER = '\n// CurrentMusic verified matcher hook (managed by tools/install-ncm-matcher.py)\n'


def install(upstream, backup, check=False):
    upstream = Path(upstream).resolve()
    runtime = ROOT / 'backend/ncm-match-runtime.cjs'
    script = "const fs=require('node:fs');process.stdout.write(fs.realpathSync(require.resolve('@neteasecloudmusicapienhanced/unblockmusic-utils/package.json',{paths:[process.argv[1]]})))"
    package = Path(subprocess.check_output(['node', '-e', script, str(upstream)], text=True))
    files = {
        package.parent / 'src/match.js': f'module.exports = {{ matchID: cm.matchID({json.dumps(str(upstream))}) }};',
        upstream / 'module/song_url_match.js': f'module.exports = cm.matchEndpoint({json.dumps(str(upstream))});',
        upstream / 'module/song_url_v1.js': f'module.exports = cm.wrapPlayback(module.exports, {json.dumps(str(upstream))});',
        upstream / 'module/song_url_v1_302.js': f'module.exports = cm.wrapPlayback(module.exports, {json.dumps(str(upstream))}, true);',
    }
    staged = []
    try:
        for path, hook in files.items():
            original = path.read_text().split(MARKER)[0]
            desired = original + MARKER + f'const cm = require({json.dumps(str(runtime))});\n' + hook + '\n'
            if check:
                if path.read_text() != desired:
                    raise ValueError(f'Matcher hook missing or outdated: {path.name}')
                continue
            digest = hashlib.sha256(original.encode()).hexdigest()
            backup.mkdir(parents=True, exist_ok=True)
            (backup / (digest + '.js')).write_text(original)
            with tempfile.NamedTemporaryFile(mode='w', suffix='.cjs', dir=path.parent, delete=False) as temp:
                temp.write(desired)
                temp_path = Path(temp.name)
            staged.append((temp_path, path))
            subprocess.run(['node', '--check', str(temp_path)], check=True, capture_output=True)
            os.chmod(temp_path, path.stat().st_mode & 0o777)
        for temp_path, path in staged:
            os.replace(temp_path, path)
    finally:
        for temp_path, _ in staged:
            temp_path.unlink(missing_ok=True)
    print('Matcher hooks verified' if check else 'Installed 4 verified matcher hooks; restart the upstream service after validation')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstream', type=Path, required=True)
    parser.add_argument('--backup', type=Path, default=ROOT / 'data/ncm-matcher-backups')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    install(args.upstream, args.backup, args.check)
