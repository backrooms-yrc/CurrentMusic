#!/usr/bin/env python3
"""Exercise Web publishing with temporary builds, without services or databases."""
import gzip
import hashlib
import importlib.util
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deploy_web', Path(__file__).with_name('deploy-web.py'))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class WebDeployTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / 'build'
        self.target = Path(self.temp.name) / 'live'
        self.source.mkdir()
        (self.source / 'app.js').write_bytes(b'window.build = 1;')
        (self.source / 'app.css').write_bytes(b'body { color: red; }')
        (self.source / 'index.html').write_text(
            '<link href="app.css?v=old"><script src="app.js?v=old"></script>')

    def references(self):
        return re.findall(r'(?:href|src)="([^"]+)"', (self.target / 'index.html').read_text())

    def test_paths_work_when_cdn_ignores_queries_and_gzip_matches(self):
        original = (self.source / 'index.html').read_bytes()
        publisher.deploy(self.source, self.target)
        for name in self.references():
            self.assertRegex(name, r'^app\.[0-9a-f]{16}\.(js|css)$')
            content = (self.target / name).read_bytes()
            self.assertIn(hashlib.sha256(content).hexdigest()[:16], name)
        for file in self.target.glob('*.gz'):
            self.assertEqual(gzip.decompress(file.read_bytes()), file.with_suffix('').read_bytes())
        self.assertEqual((self.source / 'index.html').read_bytes(), original)
        self.assertEqual((self.target / 'app.js').read_bytes(), (self.source / 'app.js').read_bytes())
        self.assertTrue((self.target / 'auto.html').is_file())

    def test_previous_html_keeps_its_assets_across_deployments(self):
        publisher.deploy(self.source, self.target)
        before = {name: (self.target / name).read_bytes() for name in self.references()}
        (self.source / 'app.js').write_bytes(b'window.build = 2;')
        (self.source / 'app.css').write_bytes(b'body { color: blue; }')
        publisher.deploy(self.source, self.target)
        self.assertTrue(set(before).isdisjoint(self.references()))
        for name, content in before.items():
            self.assertEqual((self.target / name).read_bytes(), content)

    def test_html_is_switched_after_all_referenced_assets(self):
        replace = publisher.os.replace
        def switch(src, dest):
            if Path(dest).name in ('index.html', 'index.html.gz'):
                html = (Path(src).parent / 'index.html').read_text()
                for name in re.findall(r'(?:href|src)="([^"]+)"', html):
                    self.assertTrue((self.target / name).is_file())
                    self.assertTrue((self.target / (name + '.gz')).is_file())
            replace(src, dest)
        with patch.object(publisher.os, 'replace', side_effect=switch):
            publisher.deploy(self.source, self.target)

    def test_compression_failure_keeps_live_files_untouched(self):
        publisher.deploy(self.source, self.target)
        before = {p.name: p.read_bytes() for p in self.target.iterdir()}
        (self.source / 'app.js').write_bytes(b'window.build = 2;')
        with patch.object(publisher.gzip, 'compress', side_effect=OSError('fixture')):
            with self.assertRaises(OSError):
                publisher.deploy(self.source, self.target)
        self.assertEqual({p.name: p.read_bytes() for p in self.target.iterdir()}, before)

    def test_missing_reference_does_not_replace_live_html(self):
        publisher.deploy(self.source, self.target)
        before = (self.target / 'index.html').read_bytes()
        (self.source / 'index.html').write_text('<link href="app.css">')
        with self.assertRaises(ValueError):
            publisher.deploy(self.source, self.target)
        self.assertEqual((self.target / 'index.html').read_bytes(), before)

    def test_rejects_missing_build_and_same_directory(self):
        with self.assertRaises(ValueError):
            publisher.deploy(self.source, self.source)
        (self.source / 'app.css').unlink()
        with self.assertRaises(ValueError):
            publisher.deploy(self.source, self.target)


if __name__ == '__main__':
    unittest.main()
