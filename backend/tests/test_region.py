#!/usr/bin/env python3
"""IP 属地纯逻辑测试（v1.28.38）。

覆盖两件容易写错的事：哪些地址**不该**查询（私网/回环/保留），以及展示文案
如何从国家/省份归一（中国取省份、国外取国家、繁体国名转简体）。

    python3 -m unittest backend.tests.test_region -v
"""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_region as R  # noqa: E402


class TestPrefix(unittest.TestCase):
    def test_ipv4_24(self):
        self.assertEqual(R.prefix_of("36.59.138.2"), "36.59.138.0/24")

    def test_private_and_loopback_skipped(self):
        for ip in ("10.0.0.1", "192.168.1.1", "172.16.5.5", "127.0.0.1", "::1", "0.0.0.0"):
            self.assertEqual(R.prefix_of(ip), "", ip)

    def test_invalid(self):
        self.assertEqual(R.prefix_of("not-an-ip"), "")
        self.assertEqual(R.prefix_of(""), "")


class TestHosting(unittest.TestCase):
    """机房/代理出口的 IP 不能当成用户真实属地（IDC/代理出口被误标属地的教训）。"""

    def test_idc_asn_keyword(self):
        self.assertTrue(R.looks_hosting({"as": "AS36530 IDC Cube", "hosting": False}))

    def test_akile_hk_vps(self):
        self.assertTrue(R.looks_hosting({"org": "Akile LTD", "hosting": True}))

    def test_residential_not_hosting(self):
        d = {"isp": "China Telecom", "as": "AS4134 CHINANET", "hosting": False, "proxy": False}
        self.assertFalse(R.looks_hosting(d))

    def test_empty_payload_safe(self):
        self.assertFalse(R.looks_hosting(None))
        self.assertFalse(R.looks_hosting({}))


class TestNormalize(unittest.TestCase):
    def test_china_takes_province(self):
        self.assertEqual(R.normalize("中国", "安徽"), "安徽")

    def test_china_without_region(self):
        self.assertEqual(R.normalize("中国", ""), "中国")

    def test_foreign_takes_country(self):
        self.assertEqual(R.normalize("美国", "弗吉尼亚州"), "美国")

    def test_full_province_names_normalized(self):
        """ip-api 时而是「上海市」、时而「江苏」：统一归一到省级短名。"""
        self.assertEqual(R.normalize("中国", "上海市"), "上海")
        self.assertEqual(R.normalize("中国", "河北省"), "河北")
        self.assertEqual(R.normalize("中国", "江苏"), "江苏")
        self.assertEqual(R.normalize("中国", "内蒙古自治区"), "内蒙古")
        self.assertEqual(R.normalize("中国", "广西壮族自治区"), "广西")
        self.assertEqual(R.normalize("中国", "新疆维吾尔自治区"), "新疆")
        self.assertEqual(R.normalize("中国", "宁夏回族自治区"), "宁夏")
        self.assertEqual(R.normalize("中国", "香港特别行政区"), "香港")
        self.assertEqual(R.normalize("中国", "黑龙江省"), "黑龙江")

    def test_all_34_provinces_covered(self):
        """34 个省级行政区逐个验证：短名与「X省/市/自治区」两种写法都能归一。"""
        suffixes = {
            "北京": "市", "天津": "市", "上海": "市", "重庆": "市",
            "河北": "省", "山西": "省", "辽宁": "省", "吉林": "省", "黑龙江": "省",
            "江苏": "省", "浙江": "省", "安徽": "省", "福建": "省", "江西": "省",
            "山东": "省", "河南": "省", "湖北": "省", "湖南": "省", "广东": "省",
            "海南": "省", "四川": "省", "贵州": "省", "云南": "省", "陕西": "省",
            "甘肃": "省", "青海": "省", "台湾": "省",
            "内蒙古": "自治区", "广西": "壮族自治区", "西藏": "自治区",
            "宁夏": "回族自治区", "新疆": "维吾尔自治区",
            "香港": "特别行政区", "澳门": "特别行政区",
        }
        self.assertEqual(len(suffixes), 34)
        for short, suf in suffixes.items():
            self.assertEqual(R.normalize("中国", short), short)
            self.assertEqual(R.normalize("中国", short + suf), short)

    def test_taiwan_name_normalized(self):
        """「中華民國 / 臺灣」统一为主流写法，避免出现敏感或繁体写法。"""
        self.assertEqual(R.normalize("中華民國", "臺灣省 or 台灣省"), "中国台湾")
        self.assertEqual(R.normalize("台灣", ""), "中国台湾")
        self.assertEqual(R.normalize("中國香港", ""), "香港")

    def test_traditional_country_fixed(self):
        self.assertEqual(R.normalize("澳大利亞", "Queensland"), "澳大利亚")
        self.assertEqual(R.normalize("俄羅斯", ""), "俄罗斯")


if __name__ == "__main__":
    unittest.main()
