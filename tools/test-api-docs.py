#!/usr/bin/env python3
"""文档生成覆盖检查，不请求生产 API，不访问用户数据库。"""
import ast
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('build_api_docs', ROOT/'tools/build-api-docs.py')
docs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(docs)


class DocumentationTests(unittest.TestCase):
    def test_literal_route_coverage(self):
        tree = ast.parse((ROOT/'backend/cm_server.py').read_text())
        route = next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='route')
        found = docs.routes(tree)
        for path in ('/song/qualities', '/song/chorus', '/song/versions'):
            self.assertIn(('GET', path), found)
        for node in ast.walk(route):
            if not isinstance(node, ast.If): continue
            for path in docs.condition_values(node.test,'path'):
                for method in docs.condition_values(node.test,'method'):
                    self.assertIn((method,path.rstrip('/') or '/'),found)
        for method,path in [('POST','/auth/2fa/login'),('POST','/auth/2fa/enable'),('GET','/auth/2fa/status'),('POST','/auth/login'),('GET','/network/lines'),('POST','/rooms/{id}/kick'),('POST','/passport/token'),('POST','/passport/apps/{client_id}/secret'),('GET','/share/song/{id}'),('GET','/share/local-playlist/{id}/image')]:
            self.assertIn((method,path),found)
        self.assertTrue(all('(?:' not in path and '\\d' not in path for method,path in found))
        for method,path in [('GET','/playlists/{id}'),('PUT','/playlists/{id}'),('DELETE','/playlists/{id}'),('POST','/playlists/{id}/tracks'),('DELETE','/playlists/{id}/tracks')]:
            self.assertIn((method,path),found)
        for method, path in [('GET', '/search/history'), ('POST', '/search/history'), ('DELETE', '/search/history'), ('POST', '/search/history/import')]:
            self.assertIn((method, path), found)
        fields=docs.params(found['POST','/playlists/{id}/tracks'])
        self.assertIn(('JSON body','songs'),fields)

    def test_generated_site_links_and_registry_coverage(self):
        with tempfile.TemporaryDirectory(prefix='cm-docs-test-') as d:
            output=Path(d)
            docs.build(output,output/'missing-upstream')
            metadata=json.loads((output/'build-info.json').read_text())
            self.assertFalse(metadata['upstreamDocumentationIncluded'])
            self.assertIsNone(metadata['upstreamDocsSha256'])
            manifest=json.loads((output/'manifest.json').read_text())
            upstream={item['path'] for item in manifest if item['group']=='netease'}
            self.assertEqual(upstream,{'/cm/ncm'+p for p in docs.cm_ncm_registry.REGISTRY})
            for f in output.glob('*.md'):
                text=re.sub(r'```.*?```','',f.read_text(),flags=re.S)
                for target in re.findall(r'\]\(([^)]+)\)',text):
                    if target.startswith(('http','/','#','mailto:')):continue
                    dest=target.split('#')[0].split('?')[0]
                    if dest:self.assertTrue((output/dest).is_file(),f'{f.name}: {target}')
            self.assertNotIn('@import',(output/'vendor/vue.css').read_text())
            self.assertIn('媒体地址族：必须 CurrentMusic Bearer',(output/'netease-t0.md').read_text())
            self.assertIn('返回 403',(output/'netease-t3.md').read_text())
            self.assertNotIn('\n+  --header', ''.join(f.read_text() for f in output.glob('*.md')))
            self.assertTrue((output/'licenses/docsify-MIT.txt').is_file())
            self.assertTrue((output/'guide-song-insights-api.md').is_file())


if __name__=='__main__':unittest.main()
