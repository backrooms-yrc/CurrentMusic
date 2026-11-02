#!/usr/bin/env python3
"""投屏签名（/cast 鉴权）的确定性断言（v1.28.33）。

背景：v1.28.33 起音源仅限注册用户。投屏是设备（电视/音箱）自己去拉流、发不了
Bearer 头，因此改为「登录用户换取 HMAC 签名短链，设备凭签名拉流」。签名必须：
可验证、不可伪造、不可跨歌曲/跨档位复用、过期即失效。

    python3 -m unittest backend.tests.test_cast_auth -v
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 测试用独立密钥文件：绝不能读写生产 data/cast.secret
_tmp = tempfile.NamedTemporaryFile(prefix="cm-cast-secret-", delete=False)
_tmp.close()
os.environ["CM_CAST_SECRET_FILE"] = _tmp.name

import cm_cast as C  # noqa: E402


class TestCastSignature(unittest.TestCase):
    def test_sign_then_verify(self):
        exp, sig = C.sign_cast(123456, "jymaster")
        self.assertTrue(C.verify_cast(123456, "jymaster", exp, sig))

    def test_auto_level(self):
        exp, sig = C.sign_cast(42, "auto")
        self.assertTrue(C.verify_cast(42, "auto", exp, sig))

    def test_tampered_sig_rejected(self):
        exp, sig = C.sign_cast(1, "lossless")
        self.assertFalse(C.verify_cast(1, "lossless", exp, sig[:-1] + ("0" if sig[-1] != "0" else "1")))
        self.assertFalse(C.verify_cast(1, "lossless", exp, ""))

    def test_cross_song_rejected(self):
        exp, sig = C.sign_cast(1, "lossless")
        self.assertFalse(C.verify_cast(2, "lossless", exp, sig))

    def test_cross_level_rejected(self):
        exp, sig = C.sign_cast(1, "lossless")
        self.assertFalse(C.verify_cast(1, "jymaster", exp, sig))

    def test_extended_expiry_rejected(self):
        """把 exp 往后挪（延长有效期）会让签名失效——签名覆盖 exp。"""
        exp, sig = C.sign_cast(1, "auto")
        self.assertFalse(C.verify_cast(1, "auto", exp + 3600, sig))

    def test_expired_rejected(self):
        exp, sig = C.sign_cast(1, "auto", ttl=-1)
        self.assertFalse(C.verify_cast(1, "auto", exp, sig))

    def test_garbage_exp(self):
        exp, sig = C.sign_cast(1, "auto")
        self.assertFalse(C.verify_cast(1, "auto", "abc", sig))
        self.assertFalse(C.verify_cast(1, "auto", None, sig))


if __name__ == "__main__":
    unittest.main()
