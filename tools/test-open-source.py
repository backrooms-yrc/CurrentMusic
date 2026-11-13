#!/usr/bin/env python3
"""Regressions for disclosure boundaries. All fixtures are throwaway files."""
import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'tools' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


scanner = load('oss_scan', 'check-open-source.py')
exporter = load('oss_export', 'export-open-source.py')


class OpenSourceTests(unittest.TestCase):
    def test_hidden_files_and_runtime_material_are_blocked(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            names = ['AGENTS.md', '.env', '.env.production', 'data/ncm-cookie',
                     'backend.sqlite3', 'keystore.jks', 'dist/app.apk', '.ssh/id_ed25519']
            for name in names:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('fixture')
            (root / '.env.example').write_text('CM_AI_KEY=')
            found = {path.as_posix() for path, _, _ in scanner.scan(root, True)}
            self.assertEqual(found, set(names))

    def test_extensionless_secret_is_reported_without_printing_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            secret = 'ghp_' + 'aB3dE5fG7hI9jK1lM2nO4pQ6rS8tU0vW3xY5'
            (root / 'CONFIG').write_text(secret)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                findings = scanner.scan(root, True)
            self.assertEqual(len(findings), 1)
            self.assertNotIn(secret, output.getvalue())

    def test_symlink_does_not_read_external_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'link').symlink_to('/nonexistent/private-file')
            self.assertIn('symlink', scanner.scan(root, True)[0][2])

    def test_untracked_files_are_never_selected_for_export(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            (root / 'tools').mkdir()
            (root / 'tools/check-open-source.py').write_bytes((ROOT / 'tools/check-open-source.py').read_bytes())
            (root / 'backend').mkdir()
            (root / 'backend/server.py').write_text('print("public")')
            (root / 'backend/server.py.bak-secret').write_text('local only')
            (root / 'AGENTS.md').write_text('local only')
            subprocess.run(['git', '-C', str(root), 'add', 'backend/server.py', 'tools/check-open-source.py'], check=True)
            self.assertEqual(set(exporter.source_files(root)),
                             {Path('backend/server.py'), Path('tools/check-open-source.py')})
            subprocess.run(['git', '-C', str(root), 'add', 'AGENTS.md'], check=True)
            with self.assertRaisesRegex(ValueError, 'Unreviewed|Non-public'):
                exporter.source_files(root)


if __name__ == '__main__':
    unittest.main()
