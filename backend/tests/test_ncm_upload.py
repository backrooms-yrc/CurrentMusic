#!/usr/bin/env python3
"""NCM 网关「文件上传通道」契约测试（阶段三收尾）。

为什么单独一个文件：`/playlist/cover/update` 是唯一走 multipart 的接口，
它的安全属性与其它泛化转发**不同**（多了一条"文件字节进上游"的路径），
所以白名单、体积、类型、base64 校验都要单独钉死，不能只靠登记表的 tier 测试。

上游语义（api-enhanced 的 `playlist_cover_update`）：
    参数 id + multipart 字段 imgFile；缺 imgFile 上游自己回 400。
本网关的职责是：**只给白名单路径**放文件、校验类型与体积、其余参数仍走 query。
"""
from __future__ import annotations

import base64
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_ncm_gateway as gw  # noqa: E402
import cm_ncm_registry as reg  # noqa: E402

PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 128).decode()


class TestUploadWhitelist(unittest.TestCase):
    def test_cover_update_is_uploadable(self):
        self.assertEqual(gw.upload_field("/playlist/cover/update"), "imgFile")

    def test_unknown_path_is_not_uploadable(self):
        for p in ("/banner", "/playlist/update", "/playlist/track/add", "/comment",
                  "/../etc/passwd", "/playlist/cover/update/../delete"):
            self.assertIsNone(gw.upload_field(p), f"{p} 不应接受文件上传")

    def test_uploadable_paths_are_registered_and_not_t0(self):
        """能上传的路径必须在登记表里，且不能是 T0——T0 用服务端 SVIP 档上传等于拿主账号改数据。"""
        for path in gw.UPLOAD_FIELD:
            ent = reg.entry(path)
            self.assertIsNotNone(ent, f"{path} 必须登记在 cm_ncm_registry")
            tier, _ttl, _phase = ent
            self.assertIn(tier, (reg.T1, reg.T2), f"{path} 的分级是 {tier}，上传必须是账号态")
            self.assertNotEqual(tier, reg.T3, f"{path} 是 T3，不该出现在上传白名单")


class TestDecodeUpload(unittest.TestCase):
    def test_happy_path(self):
        name, ctype, data = gw.decode_upload({"file": PNG, "filename": "c.png", "contentType": "image/png"})
        self.assertEqual(name, "c.png")
        self.assertEqual(ctype, "image/png")
        self.assertTrue(data.startswith(b"\x89PNG"))

    def test_filename_and_type_defaults_but_default_type_is_rejected(self):
        """没声明文件名/类型时给出确定性的默认值；但默认类型不在白名单 → 必须被拒，
        不能靠"不声明类型"绕过类型白名单。"""
        with self.assertRaises(ValueError) as ctx:
            gw.decode_upload({"file": PNG})
        self.assertIn("不支持的文件类型", str(ctx.exception))

    def test_rejects_non_image_audio_types(self):
        for ctype in ("text/plain", "application/x-msdownload", "image/svg+xml", "application/pdf"):
            with self.assertRaises(ValueError):
                gw.decode_upload({"file": PNG, "contentType": ctype})

    def test_rejects_missing_or_empty_file(self):
        with self.assertRaises(ValueError):
            gw.decode_upload({})
        with self.assertRaises(ValueError):
            gw.decode_upload({"file": ""})
        with self.assertRaises(ValueError):
            gw.decode_upload({"file": None})
        with self.assertRaises(ValueError):
            gw.decode_upload(None)

    def test_rejects_invalid_base64(self):
        for bad in ("!!!!", "a", "====", "AAA"):
            with self.assertRaises(ValueError):
                gw.decode_upload({"file": bad, "contentType": "image/png"})

    def test_rejects_oversize(self):
        payload = base64.b64encode(b"\x00" * (gw.UPLOAD_MAX_BYTES + 1)).decode()
        with self.assertRaises(ValueError) as ctx:
            gw.decode_upload({"file": payload, "contentType": "image/png"})
        self.assertIn("过大", str(ctx.exception))

    def test_oversize_rejected_without_decoding(self):
        """超限要在**解码前**就被长度判断挡掉（否则一个 100MB 的串会先吃满内存）。"""
        huge_len_only = "A" * ((gw.UPLOAD_MAX_BYTES // 3 + 8) * 4 + 4)
        with self.assertRaises(ValueError) as ctx:
            gw.decode_upload({"file": huge_len_only, "contentType": "image/png"})
        self.assertIn("过大", str(ctx.exception))

    def test_custom_limit_is_honoured(self):
        data = base64.b64encode(b"x" * 64).decode()
        self.assertIsNotNone(gw.decode_upload({"file": data, "contentType": "image/png"}, max_bytes=64))
        with self.assertRaises(ValueError):
            gw.decode_upload({"file": data, "contentType": "image/png"}, max_bytes=63)


class TestReservedParams(unittest.TestCase):
    def test_file_and_confirm_never_reach_query(self):
        """文件与 confirm 只能进 body/门禁，不能混进转发给上游的 query。"""
        params = gw.normalize_params("/playlist/cover/update",
                                     {"id": "1", "file": PNG, "confirm": "1", "cookie": "x"}, "POST")
        self.assertNotIn("file", params)
        self.assertNotIn("cookie", params)
        self.assertEqual(params["id"], "1")


if __name__ == "__main__":
    unittest.main(verbosity=2)
