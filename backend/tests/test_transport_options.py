"""浏览器预检应可缓存，不必每个跨域 API 请求都再走一次往返。"""
import http.client
from http.server import ThreadingHTTPServer
from pathlib import Path
import sys
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cm_server import Handler


class TransportOptionsTests(unittest.TestCase):
    def test_preflight_cache_and_permissions(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            conn = http.client.HTTPConnection(*server.server_address, timeout=3)
            conn.request('OPTIONS', '/profile', headers={
                'Origin': 'https://example.com',
                'Access-Control-Request-Method': 'PUT',
                'Access-Control-Request-Headers': 'authorization,content-type',
            })
            response = conn.getresponse()
            self.assertEqual(response.status, 204)
            self.assertEqual(response.getheader('Access-Control-Max-Age'), '600')
            self.assertEqual(response.getheader('Access-Control-Allow-Origin'), '*')
            self.assertIn('Authorization', response.getheader('Access-Control-Allow-Headers'))
            self.assertIn('PUT', response.getheader('Access-Control-Allow-Methods'))
            self.assertEqual(response.read(), b'')
            conn.close()
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=3)
