"""Installer changes only the four intended files and preserves upstream source locally."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('ncm_matcher_install', ROOT / 'tools/install-ncm-matcher.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class MatcherInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'upstream'
        self.backup = Path(self.temp.name) / 'backups'
        package = self.root / 'node_modules/@neteasecloudmusicapienhanced/unblockmusic-utils'
        (package / 'src').mkdir(parents=True)
        (package / 'package.json').write_text(json.dumps({'name': '@neteasecloudmusicapienhanced/unblockmusic-utils', 'main': 'src/match.js'}))
        (self.root / 'package.json').write_text('{}')
        (self.root / 'module').mkdir()
        self.paths = [package / 'src/match.js'] + [self.root / 'module' / name for name in ('song_url_match.js', 'song_url_v1.js', 'song_url_v1_302.js')]
        for index, path in enumerate(self.paths):
            path.write_text(f'module.exports = function original{index}() {{ return {index}; }};\n')

    def test_install_is_idempotent_and_check_detects_removed_hooks(self):
        originals = [p.read_text() for p in self.paths]
        installer.install(self.root, self.backup)
        first = [p.read_text() for p in self.paths]
        installer.install(self.root, self.backup)
        self.assertEqual(first, [p.read_text() for p in self.paths])
        self.assertEqual(sorted(originals), sorted(p.read_text() for p in self.backup.glob('*.js')))
        installer.install(self.root, self.backup, check=True)
        self.paths[1].write_text(originals[1])
        with self.assertRaisesRegex(ValueError, 'missing or outdated'):
            installer.install(self.root, self.backup, check=True)

    def test_invalid_upstream_source_does_not_partially_install(self):
        self.paths[-1].write_text('this is invalid javascript {')
        original = [p.read_bytes() for p in self.paths]
        with self.assertRaises(subprocess.CalledProcessError):
            installer.install(self.root, self.backup)
        self.assertEqual(original, [p.read_bytes() for p in self.paths])
