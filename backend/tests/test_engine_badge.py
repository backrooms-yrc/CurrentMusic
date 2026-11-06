import http.client
from http.server import ThreadingHTTPServer
from pathlib import Path
import sys
import threading
import unittest
from xml.etree import ElementTree

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cm_server import Handler


class EngineBadgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        cls.addClassCleanup(worker.join, 3)
        cls.addClassCleanup(server.server_close)
        cls.addClassCleanup(server.shutdown)
        cls.address = server.server_address

    def request(self, method="GET", query=""):
        conn = http.client.HTTPConnection(*self.address, timeout=3)
        try:
            conn.request(method, "/badges/powered-by.svg" + query)
            response = conn.getresponse()
            return response.status, response.headers, response.read()
        finally:
            conn.close()

    def test_public_svg_languages_and_embed_headers(self):
        for query, lang, title in (
            ("", "zh-CN", "由 流声引擎 强力驱动"),
            ("?lang=zh-CN", "zh-CN", "由 流声引擎 强力驱动"),
            ("?lang=en", "en", "Powered by CurrentMusic Engine"),
        ):
            with self.subTest(lang=lang, query=query):
                status, headers, body = self.request(query=query)
                self.assertEqual(status, 200)
                self.assertEqual(headers["Content-Type"], "image/svg+xml; charset=utf-8")
                self.assertEqual(headers["Content-Length"], str(len(body)))
                self.assertEqual(headers["Cache-Control"], "public, max-age=3600")
                self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
                self.assertEqual(headers["Cross-Origin-Resource-Policy"], "cross-origin")
                svg = ElementTree.fromstring(body)
                self.assertEqual(svg.tag, "{http://www.w3.org/2000/svg}svg")
                self.assertEqual(svg.attrib["{http://www.w3.org/XML/1998/namespace}lang"], lang)
                self.assertEqual(svg.findtext("{http://www.w3.org/2000/svg}title"), title)
                labels = svg.findall(".//{http://www.w3.org/2000/svg}text")
                self.assertEqual(" ".join("".join(label.itertext()) for label in labels), title)

    def test_head_matches_get_without_a_body(self):
        _, get_headers, _ = self.request(query="?lang=en")
        status, headers, body = self.request(method="HEAD", query="?lang=en")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Length"], get_headers["Content-Length"])
        self.assertEqual(headers["Content-Type"], get_headers["Content-Type"])
        self.assertEqual(body, b"")

    def test_unknown_language_is_rejected(self):
        for query in ("?lang=", "?lang=de"):
            with self.subTest(query=query):
                status, headers, _ = self.request(query=query)
                self.assertEqual(status, 400)
                self.assertEqual(headers["Content-Type"], "application/json; charset=utf-8")
