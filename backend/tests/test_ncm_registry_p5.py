"""阶段五（音频生态与增值长尾）契约测试。

阶段五覆盖电台/播客/广播、私人 FM 与场景、VIP 会员、云贝、音乐人、数字专辑、
云小编、广告权益、粉丝中心、助眠解压、话题热榜与杂项，共 131 条（**无 T3**）。

本阶段的分级风险与前面相反：写操作标记（`/sign`、`/collect`、`/lottery`、`/create`…）
太宽，把一批**账号维度的读**判成了 T2。留 T2 的后果不是数据泄露，而是
「纯查询也要 confirm=1 并进写审计」；而如果为了修它直接降到 T0，就会用服务端
SVIP cookie 去读主账号数据 —— **两个方向都会错**。所以下面这些被单独钉死：
它们既是 READ_OVERRIDES（不当写）又是 ACCOUNT_READ（不当公开读）。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_ncm_registry as reg  # noqa: E402

# 公开只读（50）：电台/播客/广播目录、搜索匹配、场景资源、版本与二维码
P5_T0 = [
    "/ad/get", "/batch", "/broadcast/category/region/get", "/broadcast/channel/currentinfo",
    "/broadcast/channel/list", "/creator/authinfo/get", "/dj/banner",
    "/dj/category/excludehot", "/dj/category/recommend", "/dj/catelist", "/dj/detail",
    "/dj/difm/all/style/channel", "/dj/difm/playing/tracks/list", "/dj/hot", "/dj/paygift",
    "/dj/personalize/recommend", "/dj/program", "/dj/program/detail", "/dj/program/toplist",
    "/dj/program/toplist/hours", "/dj/radio/hot", "/dj/recommend", "/dj/recommend/type",
    "/dj/today/perfered", "/dj/toplist", "/dj/toplist/hours", "/dj/toplist/newcomer",
    "/dj/toplist/pay", "/dj/toplist/popular", "/djRadio/top", "/hot/topic", "/inner/version",
    "/lbs/city/code", "/program/recommend", "/sati/resource/list",
    "/sati/resource/list/more", "/sati/tag/list", "/sati/timescene/resources/get",
    "/search/match", "/search/multimatch", "/starpick/comments/summary",
    "/threshold/detail/get", "/verify/getQr", "/verify/qrcodestatus", "/voice/detail",
    "/voice/lyric", "/voicelist/detail", "/voicelist/list", "/voicelist/list/search",
    "/voicelist/search",
]

# 账号只读（54）：我的订阅/收藏、会员与云贝信息、音乐人数据、粉丝画像
P5_T1 = [
    "/ad/listening/rights", "/aidj/content/rcmd", "/broadcast/channel/collect/list",
    "/digitalAlbum/detail", "/digitalAlbum/purchased", "/digitalAlbum/sales",
    "/dj/difm/subscribe/channels/get", "/dj/sublist", "/dj/subscriber",
    "/fanscenter/basicinfo/age/get", "/fanscenter/basicinfo/gender/get",
    "/fanscenter/basicinfo/province/get", "/fanscenter/overview/get",
    "/fanscenter/trend/list", "/middle/play/lottery/remain/chance", "/musician/cloudbean",
    "/musician/data/overview", "/musician/play/trend", "/musician/tasks",
    "/musician/tasks/new", "/musician/vip/tasks", "/personal/fm/mode", "/personal_fm",
    "/playmode/intelligence/list", "/radio/sport/get", "/rep/ugc/activity/get",
    "/rep/ugc/exam/info/get", "/rep/ugc/exam/question/single/get",
    "/rep/ugc/exam/result/get", "/rep/ugc/user/get", "/rep/ugc/user/vip",
    "/thinktank/audit/resource/detail", "/vip/growthpoint", "/vip/growthpoint/details",
    "/vip/info", "/vip/info/v2", "/vip/sign/detail", "/vip/sign/history", "/vip/sign/info",
    "/vip/tasks", "/vip/tasks/v1", "/vip/timemachine", "/voicelist/my/created", "/yunbei",
    "/yunbei/expense", "/yunbei/info", "/yunbei/rcmd/song/history", "/yunbei/receipt",
    "/yunbei/task/list/v1", "/yunbei/task/recommend/song", "/yunbei/tasks",
    "/yunbei/tasks/todo", "/yunbei/today",
]

# 账号写（27）：订阅/收藏、签到、领云贝、抽奖、投稿、播客上传与转写
P5_T2 = [
    "/ad/listening/rights/gain", "/broadcast/sub", "/digitalAlbum/ordering",
    "/dj/difm/channel/subscribe", "/dj/difm/channel/unsubscribe", "/dj/sub", "/fm_trash",
    "/middle/play/do/lottery", "/musician/cloudbean/obtain", "/musician/sign",
    "/rep/ugc/activity/collect", "/rep/ugc/exam/start", "/rep/ugc/exam/submit",
    "/rep/ugc/user/collect-vip", "/rep/ugc/user/sign", "/sati/resource/sub",
    "/sati/resource/sub/list", "/thinktank/audit/resource/update", "/vip/growthpoint/get",
    "/vip/growthpoint/getall", "/vip/sign", "/voice/delete", "/voice/upload",
    "/voicelist/trans", "/yunbei/rcmd/song", "/yunbei/sign", "/yunbei/task/finish",
    "/yunbei/task/finish/v1",
]

# 被写动词误判、经审计纠正为「账号维度读（T1）」的 10 条
AUDITED_READS = [
    "/rep/ugc/exam/info/get", "/rep/ugc/exam/question/single/get", "/rep/ugc/exam/result/get",
    "/vip/sign/detail", "/vip/sign/history", "/vip/sign/info",
    "/middle/play/lottery/remain/chance",
    "/broadcast/channel/collect/list", "/voicelist/my/created",
    "/dj/difm/subscribe/channels/get",
]


class TestP5SafetyInvariants(unittest.TestCase):
    def test_public_reads_are_t0(self):
        for p in P5_T0:
            e = reg.entry(p)
            self.assertIsNotNone(e, f"{p} 未登记")
            self.assertEqual(e[0], reg.T0, f"{p} 是公开目录/搜索类读，应为 T0 而不是 {e[0]}")

    def test_account_reads_are_t1(self):
        for p in P5_T1:
            e = reg.entry(p)
            self.assertIsNotNone(e, f"{p} 未登记")
            self.assertEqual(e[0], reg.T1, f"{p} 是账号维度读，应为 T1 而不是 {e[0]}")

    def test_writes_are_t2(self):
        for p in P5_T2:
            e = reg.entry(p)
            self.assertIsNotNone(e, f"{p} 未登记")
            self.assertEqual(e[0], reg.T2, f"{p} 是写操作，应为 T2 而不是 {e[0]}")

    def test_audited_reads_are_t1_not_t2(self):
        """这 10 条路径里含 `/sign`、`/collect`、`/lottery`、`/create` 等写动词，
        但上游其实是 `/get`、`/list`、`/sign/info`、`/remain/chance` 这类查询。
        判成 T2 会让纯查询也要二次确认并写审计；判成 T0 会用服务端 SVIP 档读主账号数据。"""
        for p in AUDITED_READS:
            e = reg.entry(p)
            self.assertIsNotNone(e, f"{p} 未登记")
            self.assertEqual(e[0], reg.T1, f"{p} 是账号维度读，必须是 T1（当前 {e[0]}）")

    def test_real_writes_with_same_verbs_stay_t2(self):
        """同一批动词里**真的**是写的那些不能被上面那条顺带放宽。"""
        for p in ["/vip/sign", "/yunbei/sign", "/musician/sign", "/rep/ugc/user/sign",
                  "/vip/growthpoint/get", "/yunbei/task/finish", "/voice/upload",
                  "/broadcast/sub", "/dj/sub", "/sati/resource/sub"]:
            self.assertEqual(reg.entry(p)[0], reg.T2, f"{p} 是写操作，应保持 T2")

    def test_account_scope_never_lands_on_svip_tier(self):
        for p in P5_T1 + P5_T2:
            self.assertNotEqual(reg.entry(p)[0], reg.T0, p)

    def test_no_t3_in_phase5(self):
        """阶段五不该出现 T3：它全是业务长尾，没有登录/验证码/换绑这类敏感接口。
        出现 T3 说明分级器把某个业务接口误判成了敏感接口（会让它彻底不可用）。"""
        t3 = [p for p, (tier, _ttl, ph) in reg.REGISTRY.items() if ph == 5 and tier == reg.T3]
        self.assertEqual(t3, [], f"阶段五出现 T3：{t3}")


class TestP5PhaseGate(unittest.TestCase):
    def test_phase5_enabled_and_forwardable(self):
        self.assertGreaterEqual(reg.ENABLED_PHASE, 5)
        for p in P5_T0 + P5_T1 + P5_T2:
            self.assertTrue(reg.is_forwardable(p), f"{p} 阶段五应已可转发")

    def test_phase5_count_matches_plan(self):
        """阶段五应为 131 条（计划口径）；数量变动必须同步 docs/api-5-phase-plan.md。"""
        n = sum(1 for _t, _ttl, ph in reg.REGISTRY.values() if ph == 5)
        self.assertEqual(n, 131, f"阶段五条数变为 {n}，请同步文档")


if __name__ == "__main__":
    unittest.main(verbosity=2)
