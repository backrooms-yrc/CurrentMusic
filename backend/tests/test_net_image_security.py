import io
import os
import struct
import sys
import unittest
import zlib

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cm_image  # noqa: E402
import cm_net  # noqa: E402


class TestSafeFetch(unittest.TestCase):
    def test_allows_ncm_cdn(self):
        cm_net._check("https://p1.music.126.net/a.jpg?param=800y800", ("music.126.net",))
        cm_net._check("http://music.126.net/a.jpg", ("music.126.net",))

    def test_rejects_internal_and_lookalike(self):
        for url in (
            "http://127.0.0.1:3010/health",
            "http://169.254.169.254/latest/meta-data/",
            "https://music.126.net.evil.example/a.jpg",
            "https://evilmusic.126.net/a.jpg",
            "ftp://p1.music.126.net/a.jpg",
            "https://user:pass@p1.music.126.net/a.jpg",
            "https://p1.music.126.net:8080/a.jpg",
            "https://p1.music.126.net:abc/a.jpg",
        ):
            with self.assertRaises(cm_net.FetchError, msg=url):
                cm_net._check(url, ("music.126.net",))

    def test_redirects_disabled(self):
        h = cm_net._NoRedirect()
        self.assertIsNone(h.redirect_request(None, None, 302, "", {}, "http://127.0.0.1/"))


class TestSafeImage(unittest.TestCase):
    @staticmethod
    def _png(width, height):
        def chunk(kind, data):
            return (struct.pack(">I", len(data)) + kind + data +
                    struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff))
        ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
        return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) +
                chunk(b"IDAT", zlib.compress(b"\x00\x00\x00\x00")) + chunk(b"IEND", b""))

    def test_normal_png(self):
        try:
            from PIL import Image
        except Exception:
            self.skipTest("PIL 不可用")
        buf = io.BytesIO()
        Image.new("RGB", (2, 2), (1, 2, 3)).save(buf, format="PNG")
        im = cm_image.open_image(buf.getvalue())
        self.assertEqual(im.size, (2, 2))

    def test_pixel_limit_before_decode(self):
        with self.assertRaises(ValueError):
            cm_image.open_image(self._png(10000, 10000), max_pixels=1_000_000)

    def test_rejects_unlisted_format(self):
        buf = io.BytesIO()
        try:
            from PIL import Image
        except Exception:
            self.skipTest("PIL 不可用")
        Image.new("RGB", (2, 2), (255, 0, 0)).save(buf, format="BMP")
        with self.assertRaises(ValueError):
            cm_image.open_image(buf.getvalue())


if __name__ == "__main__":
    unittest.main()
