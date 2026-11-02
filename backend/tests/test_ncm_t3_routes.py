#!/usr/bin/env python3
"""T3 专用入口契约测试。

上游的登录/验证码/注册/换绑/设置类接口在登记表里是 **T3**：泛化转发对它们一律 403，
因此只能由项目显式实现（cm_server 的 `_T3_ROUTES`）。这带来两条必须钉死的不变量：

1. **覆盖完整**：登记表里每一条 T3 都要有专用入口，否则那个功能在项目里根本不可达
   （覆盖率工具会把缺 A 的路径算成缺口）。反过来，专用入口不得指向非 T3 的上游 ——
   那等于绕开"登记表 + 阶段门禁"这套放量机制。
2. **安全属性不降级**：T3 只是"不经泛化转发"，鉴权/二次确认/审计一样都不能少。
"""
from __future__ import annotations

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_ncm_registry as reg  # noqa: E402

SERVER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cm_server.py")


def t3_routes() -> dict:
    """从 cm_server.py 里解析 `_T3_ROUTES` 表（避免 import 整个服务模块）。"""
    with open(SERVER, encoding="utf-8") as f:
        text = f.read()
    block = re.search(r"_T3_ROUTES = \{(.*?)\n\}", text, re.S)
    assert block, "未找到 _T3_ROUTES"
    out = {}
    for m in re.finditer(r'"(/ncm/[^"]+)":\s*\("([^"]+)",\s*(True|False),\s*(True|False)\)', block.group(1)):
        out[m.group(1)] = (m.group(2), m.group(3) == "True", m.group(4) == "True")
    return out


class TestT3Coverage(unittest.TestCase):
    def test_every_registry_t3_has_a_dedicated_entry(self):
        """T3 的专用入口有两种落地方式，两种都算（与覆盖率工具 A 层同一口径）：

        1. cm_server 的 `_T3_ROUTES` 表（登录/验证码/注册/换绑/设置这一批）；
        2. `cm_ncm.py` 里的专用调用（`/ncmbind/qr/*` → `/login/qr/*`、
           `/ncmbind/phone/*` → `/login/cellphone` + `/captcha/*`、
           `/ncmbind/live`、`/ncmbind/refresh` → `/login/{status,refresh}`）——
           这些是更早就存在的项目专用入口。
        """
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "cov", os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
                os.path.abspath(__file__)))), "tools", "ncm-coverage.py"))
        cov = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cov)
        want = {p for p, (tier, _ttl, _ph) in reg.REGISTRY.items() if tier == reg.T3}
        got = {up for (_path, (up, _w, _b)) in t3_routes().items()} | cov.dedicated_calls()
        missing = sorted(want - got)
        self.assertEqual(missing, [], f"这些 T3 没有任何专用入口（项目内不可达）：{missing}")

    def test_no_dedicated_route_targets_a_non_t3_upstream(self):
        for path, (up, _w, _b) in t3_routes().items():
            ent = reg.entry(up)
            self.assertIsNotNone(ent, f"{path} 指向未登记的上游 {up}")
            self.assertEqual(ent[0], reg.T3,
                             f"{path} → {up} 不是 T3：能走泛化转发的接口不该单开专用入口（会绕开放量闸门）")

    def test_route_keys_follow_the_ncm_prefix_convention(self):
        """覆盖率工具的 A 层认的是 `/ncm/<上游路径>` 这个写法，键名写歪就会漏算。"""
        for path, (up, _w, _b) in t3_routes().items():
            self.assertEqual(path, "/ncm" + up, f"{path} 与上游 {up} 不匹配")


class TestT3Safety(unittest.TestCase):
    @staticmethod
    def _t3_body():
        with open(SERVER, encoding="utf-8") as f:
            text = f.read()
        body = text[text.index("def _ncm_t3("):]
        return body[:body.index("\ndef ", 10)]

    def test_all_t3_routes_are_authenticated(self):
        """`_ncm_t3` 对每条路由都先 require_user；这里守住"没有例外"这件事。"""
        body = self._t3_body()
        self.assertIn("require_user(handler)", body, "T3 入口必须先做项目鉴权")

    def test_writes_require_confirm_and_are_audited(self):
        body = self._t3_body()
        self.assertIn("二次确认", body, "T3 写操作必须要求 confirm=1")
        self.assertIn("confirm=1", body, "T3 写操作的报错里要写清楚怎么确认")
        self.assertIn("审计", body, "T3 写操作必须写审计日志")

    def test_bound_routes_do_not_fall_back_to_svip_cookie(self):
        """需要绑定的 T3 路由拿不到绑定时**必须**报错，绝不能退回服务端 SVIP 档。"""
        body = self._t3_body()
        self.assertIn("请先绑定网易云账号", body)

    def test_none_of_them_is_forwardable_through_the_gateway(self):
        for up in [u for (_p, (u, _w, _b)) in t3_routes().items()]:
            self.assertFalse(reg.is_forwardable(up), f"{up} 是 T3，任何阶段都不该可泛化转发")


if __name__ == "__main__":
    unittest.main(verbosity=2)
