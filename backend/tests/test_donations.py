"""官方捐赠渠道 API 的回归测试：提交校验、单号去重、本人历史与管理台列表。"""
import json
import os
import tempfile
import unittest
from unittest import mock

from test_password_reset import _Handler
import cm_db
import cm_server


class DonationsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.enterContext(mock.patch.object(cm_db, "DB_PATH", os.path.join(tmp.name, "test.db")))
        self.enterContext(mock.patch.object(cm_server.cm_region, "note"))
        cm_db.init()
        self.uid = cm_db.create_user("donor", "password123", "捐赠用户")
        self.token = cm_db.issue_token(self.uid)
        admin = cm_db.create_user("donationadmin", "password123", "管理")
        cm_db.set_admin(admin, True)
        self.admin_token = cm_db.issue_token(admin)

    def request(self, method, path, body=None, token=None):
        h = _Handler(method, path, body, token=token or "")
        try:
            cm_server.route(h, method)
        except cm_server.ApiError as e:
            return e.code, {"error": e.msg}
        try:
            return h.status, json.loads(h.wfile.getvalue())
        except ValueError:      # 二维码等二进制响应
            return h.status, None

    def test_qr_is_public(self):
        # 二维码图片无需登录（<img> 不能带 Authorization 头）
        status, _ = self.request("GET", "/donation/qr")
        if not os.path.isfile(os.path.join(os.path.dirname(cm_server.__file__), "assets", "donation-qr.jpg")):
            self.assertEqual(status, 404)
        else:
            self.assertEqual(status, 200)

    def test_info_requires_login_and_prefills_profile(self):
        self.assertEqual(self.request("GET", "/donation/info")[0], 401)
        status, info = self.request("GET", "/donation/info", token=self.token)
        self.assertEqual(status, 200)
        self.assertEqual(info["profile"]["username"], "donor")
        self.assertIn("created_at", info["profile"])
        self.assertEqual(info["mine"]["count"], 0)

    def test_submit_validation_and_dedupe(self):
        path = "/donation"
        self.assertEqual(self.request("POST", path, {"amount": 5, "txnId": "TX123456"})[0], 401)
        for bad in ({"amount": 0, "txnId": "TX123456"}, {"amount": 5, "txnId": "TX1"},
                    {"amount": 5, "txnId": "TX 12 34"}, {"amount": "5", "txnId": "TX123456"}):
            self.assertEqual(self.request("POST", path, bad, self.token)[0], 400, bad)
        status, r = self.request("POST", path, {"amount": 6.6, "txnId": "TX20261113001", "note": "加油"}, self.token)
        self.assertEqual(status, 200)
        self.assertEqual(r["mine"]["count"], 1)
        self.assertEqual(r["mine"]["totalCents"], 660)
        self.assertEqual([i["txn_id"] for i in r["mine"]["items"]], ["TX20261113001"])
        # 同一单号重复提交 → 409
        self.assertEqual(self.request("POST", path, {"amount": 6.6, "txnId": "TX20261113001"}, self.token)[0], 409)

    def test_admin_list_and_delete(self):
        self.assertEqual(self.request("GET", "/admin/donations", token=self.token)[0], 403)
        self.request("POST", "/donation", {"amount": 10, "txnId": "TXA000001", "note": "第一次"}, self.token)
        self.request("POST", "/donation", {"amount": 20, "txnId": "TXA000002"}, self.token)
        status, d = self.request("GET", "/admin/donations?sort=amount", token=self.admin_token)
        self.assertEqual(status, 200)
        self.assertEqual((d["totalCount"], d["donors"], d["totalCents"]), (2, 1, 3000))
        self.assertEqual(len(d["items"]), 2)
        it = d["items"][0]
        self.assertEqual((it["username"], it["userCount"], it["userTotalCents"]), ("donor", 2, 3000))
        self.assertEqual(it["amount_cents"], 2000)   # user_total 排序后首条为金额大的一笔
        # 搜索：按备注 / 单号 / 用户名
        _, s = self.request("GET", "/admin/donations?query=TXA000002", token=self.admin_token)
        self.assertEqual(s["total"], 1)
        _, s = self.request("GET", "/admin/donations?query=donor", token=self.admin_token)
        self.assertEqual(s["total"], 2)
        # 删除
        self.assertEqual(self.request("DELETE", f"/admin/donations/{it['id']}", token=self.admin_token)[0], 200)
        _, d2 = self.request("GET", "/admin/donations", token=self.admin_token)
        self.assertEqual((d2["totalCount"], d2["totalCents"]), (1, 1000))
        self.assertEqual(self.request("DELETE", f"/admin/donations/{it['id']}", token=self.admin_token)[0], 404)


if __name__ == "__main__":
    unittest.main()
