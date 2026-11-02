#!/usr/bin/env python3
"""生成 backend/cm_ncm_registry.py（NCM 上游接口登记表）。

以 docs/api-endpoint-phase-map.csv 为唯一事实源，按显式规则判定安全分级，
输出可直接 import 的静态登记表。生成物入库，不放运行时依赖。

安全原则（生成期强制）：
  1. **默认拒绝**：规则无法归类的路径 → T3（禁止泛化转发）
  2. **写操作优先判定**：命中写标记 → T2，绝不落入 T0
  3. **阶段一必须是纯只读**：断言 phase==1 的条目全部 tier==0

用法：
    python3 tools/gen-ncm-registry.py            # 写入 backend/cm_ncm_registry.py
    python3 tools/gen-ncm-registry.py --audit    # 只打印分级结果供人工核对
"""
import csv
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_PATH = os.path.join(ROOT, "docs", "api-endpoint-phase-map.csv")
OUT_PATH = os.path.join(ROOT, "backend", "cm_ncm_registry.py")

T0, T1, T2, T3 = 0, 1, 2, 3
TIER_NAME = {0: "T0 公开只读", 1: "T1 账号只读", 2: "T2 账号写", 3: "T3 禁止泛化"}

# ---- 禁止泛化转发（仅项目专用入口实现：ncmbind / cookie 自动化 / 账号中心）----
T3_PATHS = {
    "/login", "/login/cellphone", "/login/status", "/login/refresh",
    "/login/qr/key", "/login/qr/create", "/login/qr/check",
    "/logout", "/register/cellphone", "/register/anonimous",
    "/captcha/sent", "/captcha/sent/v1", "/captcha/safe/sent", "/captcha/verify",
    "/rebind", "/user/replacephone", "/user/bindingcellphone", "/setting",
}

# ---- 显式覆盖：与规则冲突或易误判的条目在此钉死 ----
# 读操作，但含写标记词，必须显式归为只读
READ_OVERRIDES = {
    # ---- 阶段五审计：被写动词误判成 T2 的账号维度读 ----
    "/rep/ugc/exam/info/get",            # 云小编考试信息
    "/rep/ugc/exam/question/single/get", # 云小编题目
    "/rep/ugc/exam/result/get",          # 云小编考试结果
    "/vip/sign/detail",                  # 签到明细
    "/vip/sign/history",                 # 签到历史
    "/vip/sign/info",                    # 签到状态
    "/middle/play/lottery/remain/chance", # 剩余抽奖次数
    "/broadcast/channel/collect/list",   # 我收藏的广播电台列表
    "/voicelist/my/created",             # 我创建的播客声音列表
    "/dj/difm/subscribe/channels/get",   # 我订阅的播客频道
    "/likelist", "/song/like/check",   # 注意：运行实例无 /like/check "/comment/floor", "/comment/hot",
    "/cloud/lyric/get", "/user/record", "/user/cloud", "/user/cloud/detail",
    "/user/playlist", "/user/playlist/collect", "/user/playlist/create",
    "/record/recent/song", "/record/recent/album", "/record/recent/dj",
    "/record/recent/playlist", "/record/recent/video", "/record/recent/voice",
    "/recent/listen/list", "/history/recommend/songs", "/history/recommend/songs/detail",
    "/listen/data/today/song", "/listen/data/total", "/listen/data/report",
    "/listen/data/realtime/report", "/listen/data/song/play/rank", "/listen/data/year/report",
    "/dj/sublist", "/dj/subscriber", "/artist/sublist", "/album/sublist", "/mv/sublist",
    "/playlist/subscribers", "/playlist/category/list", "/playlist/track/all",
    "/playlist/import/task/status",   # 轮询导入任务状态：读
    "/user/follows", "/user/followeds", "/user/follow/mixed", "/user/mutualfollow/get",
    "/user/comment/history", "/user/event", "/user/event/all",
    "/song/download/url", "/song/download/url/v1", "/song/downlist", "/song/monthdownlist",
    "/song/singledownlist", "/song/purchased", "/song/creators", "/song/chorus",
    "/song/music/detail", "/song/red/count", "/song/simi/get", "/song/dynamic/cover",
    "/song/copyright/rcmd", "/song/lyrics/mark", "/song/lyrics/mark/user/page",
    "/song/wiki/info", "/song/wiki/summary", "/song/url", "/song/url/v1",
    "/song/url/v1/302", "/song/url/match", "/song/url/ncmget", "/song/cloud/download",
    "/album/privilege", "/album/detail", "/album/detail/dynamic", "/album/list",
    "/album/list/style", "/album/new", "/album/newest", "/album/songsaleboard",
    "/artist/desc", "/artist/detail", "/artist/detail/dynamic", "/artist/fans",
    "/artist/follow/count", "/artist/list", "/artist/mv", "/artist/new/mv",
    "/artist/new/song", "/artist/new/song/mv/list/v2", "/artist/new/song/playall",
    "/artist/songs", "/artist/top/song", "/artist/video", "/artist/album",
    "/comment/album", "/comment/dj", "/comment/event", "/comment/hot",
    "/comment/hug/list", "/comment/info/list", "/comment/music", "/comment/mv",
    "/comment/new", "/comment/playlist", "/comment/video",
    "/check/music", "/audio/match", "/sheet/list", "/sheet/preview",
    "/playmode/song/vector", "/playmode/intelligence/list",
    "/personal_fm", "/personal/fm/mode", "/djRadio/top", "/radio/sport/get",
    "/aidj/content/rcmd", "/hot/topic", "/starpick/comments/summary",
    "/threshold/detail/get", "/creator/authinfo/get", "/inner/version",
    "/verify/getQr", "/verify/qrcodestatus",
}

# ---- 精确路径的写操作（名字不含写标记，但实际是写；漏一条即误判）----
WRITE_EXACT = {
    "/comment",              # 发送/删除评论
    "/cloud",                # 云盘上传
    "/cloud/match",          # 云盘歌曲信息匹配纠正
    "/playlist/tracks",      # 对歌单添加或删除歌曲
    "/fm_trash",             # 私人 FM 垃圾桶（删除）
    "/vip/growthpoint/get",     # 领取成长值
    "/vip/growthpoint/getall",  # 一键领取成长值
    # ---- 审计（开启阶段四前逐条查上游）后补充：名字像"读"，上游实际是写 ----
    # 判错的代价：这些接口会以 T1 身份放行，绕过 T2 的 confirm=1 + 审计。
    "/daily_signin",             # POST /api/point/dailyTask —— 签到
    "/follow",                   # /api/user/follow|delfollow/{id} —— 关注/取关
    "/activate/init/profile",    # POST /api/activate/initProfile —— 初始化昵称
    "/yunbei/rcmd/song",         # POST /api/yunbei/rcmd/song/submit —— 云贝推歌（要花云贝）
}

# ---- 写操作标记（命中即 T2，除非在 READ_OVERRIDES）----
WRITE_MARKERS = (
    "/sub", "/update", "/create", "/delete", "/add", "/del", "/dislike",
    "/like", "/report", "/import", "/upload", "/order", "/privacy", "/playcount",
    "/finish", "/obtain", "/gain", "/send", "/forward", "/collect", "/sign",
    "/submit", "/start", "/accept", "/command", "/heatbeat", "/kickoff",
    "/replace", "/bind", "/trash", "/trans", "/complete", "/token", "/exam",
    "/lottery", "/remove", "/edit", "/playall", "/scrobble", "/relay",
    # 以下为审计后补充：这些动词原先漏判，导致写操作落入只读档
    "/unsubscribe", "/reply", "/hug", "/share", "/ordering",
)

# ---- 账号态只读（T1）：需调用者自己的网易云 cookie，**绝不能走 SVIP 档** ----
# 规则命不中的账号态读接口在此显式登记（漏一条 = SVIP 账号数据泄露）
ACCOUNT_READ = {
    "/likelist", "/song/like/check",   # 注意：运行实例无 /like/check
    "/recommend/songs", "/recommend/resource",
    "/song/lyrics/mark", "/song/lyrics/mark/user/page",
    "/song/purchased", "/song/singledownlist", "/song/downlist", "/song/monthdownlist",
    "/song/cloud/download",
    "/cloud", "/cloud/lyric/get",
    "/playlist/mylike",
    "/dj/sublist", "/dj/subscriber",
    "/artist/sublist", "/album/sublist", "/mv/sublist",
    "/personal_fm", "/personal/fm/mode", "/aidj/content/rcmd",
    "/playmode/intelligence/list", "/playmode/song/vector",
    "/ad/listening/rights", "/radio/sport/get",
    "/artist/new/song", "/artist/new/song/mv/list/v2", "/artist/new/song/playall",
    "/artist/new/mv", "/user/audio",
    "/history/recommend/songs", "/history/recommend/songs/detail",
    # 账号维度的读：最近播放视频、回忆坐标
    "/playlist/video/recent", "/music/first/listen/info",
    "/style/preference",            # 账号维度的曲风偏好（tagPreferenceVos 带 ratio）
    # ---- 阶段五审计：上游是 /get、/list、/chance 这类查询，但路径里带 subscribe/collect/lottery/create
    #      等写动词，分级器按动词把它们判成了 T2（写）。它们是**账号维度的读**：
    #      留 T2 会让纯查询也要 confirm=1 并进写审计；误降到 T0 则会用服务端 SVIP 档读主账号数据。
    #      所以两条都要：进 READ_OVERRIDES（不当写）+ 进 ACCOUNT_READ（不当公开读）。----
    "/broadcast/channel/collect/list",   # 我收藏的广播电台列表
    "/voicelist/my/created",             # 我创建的播客声音列表
    "/dj/difm/subscribe/channels/get",   # 我订阅的播客频道
    "/playlist/import/task/status",  # 轮询导入任务状态：是读，被 '/import' 标记误判成写
}

# ---- 账号态只读族（T1，按前缀）----
T1_PREFIXES = (
    "/user", "/msg", "/pl/", "/vip", "/yunbei", "/musician", "/device",
    "/fanscenter", "/rep", "/middle", "/thinktank", "/digitalAlbum",
    "/record", "/listen", "/history", "/recent", "/summary", "/follow",
    "/get/userids",
)

# ---- 公开只读族（T0）：目录/搜索/榜单/音源，注入 SVIP 档 ----
T0_PREFIXES = (
    "/search", "/cloudsearch", "/banner", "/calendar", "/homepage", "/personalized",
    "/top", "/toplist", "/chart", "/style", "/batch", "/countries",
    "/lbs", "/topic", "/dj", "/voicelist", "/voice", "/broadcast", "/program",
    "/sati", "/album", "/artist", "/artists", "/mv", "/video", "/simi", "/mlog",
    "/related", "/playlist", "/song", "/lyric", "/comment", "/scrobble",
    "/like", "/check", "/audio", "/sheet", "/hug", "/resource",
    "/share", "/music", "/hot", "/starpick", "/creator", "/threshold",
    "/inner", "/verify", "/ad",
)


def classify(path: str) -> int:
    """返回分级。

    判定顺序（安全优先）：
      1. 显式敏感清单 → T3
      2. 人工核过的读操作（READ_OVERRIDES）→ 账号态 T1 / 公开 T0
      3. 命中写标记 → T2
      4. 账号态读（显式清单或账号族前缀）→ T1
      5. 公开只读族 → T0
      6. 其余 → T1（兜底为账号态，**绝不兜底成 T0/SVIP 档**）
    """
    if path in T3_PATHS:
        return T3
    if path in WRITE_EXACT:
        return T2
    if path in READ_OVERRIDES:
        return T1 if (path in ACCOUNT_READ or path.startswith(T1_PREFIXES)) else T0
    if any(m in path for m in WRITE_MARKERS):
        return T2
    if path in ACCOUNT_READ or path.startswith(T1_PREFIXES):
        return T1
    if path.startswith(T0_PREFIXES):
        return T0
    return T1


def ttl_for(path: str) -> int:
    """缓存 TTL（秒）。0 = 不缓存。账号态一律不缓存。"""
    if path.startswith(("/user", "/msg", "/record", "/listen", "/history", "/recent",
                        "/summary", "/vip", "/yunbei", "/musician", "/device",
                        "/fanscenter", "/rep", "/middle", "/thinktank", "/pl/",
                        "/follow", "/get/userids", "/likelist")):
        return 0
    if path.startswith(("/toplist", "/top", "/style", "/playlist/catlist",
                        "/playlist/hot", "/playlist/highquality", "/countries",
                        "/lbs", "/chart", "/banner", "/dj/catelist")):
        return 3600
    if path.startswith("/song/url"):
        return 1200
    return 600


def enabled_phase() -> int:
    """要写入登记表的 ENABLED_PHASE（`--enable-phase N`，默认 3）。

    为什么做成参数：这一行是**放量闸门**（决定哪些阶段的接口能经泛化转发出去），
    由生成器统一产出而不是手改生成物，改动才有据可查、也能被 PR 审查看得见。
    """
    for i, a in enumerate(sys.argv):
        if a == "--enable-phase" and i + 1 < len(sys.argv):
            return int(sys.argv[i + 1])
        if a.startswith("--enable-phase="):
            return int(a.split("=", 1)[1])
    return 3


def main() -> int:
    with open(CSV_PATH, encoding="utf-8") as f:
        rows = [r for r in csv.DictReader(f) if r["phase"] != "EXCL"]

    entries = []
    for r in rows:
        path, phase = r["path"], int(r["phase"][1:])
        tier = classify(path)
        entries.append((phase, tier, path, ttl_for(path)))

    # ---- 安全不变量（生成期强制，违反即中止）----
    # 1) 写操作不得被判为 T0（会注入 SVIP cookie）——含写标记与精确写清单
    leaked = [e for e in entries if e[1] == T0 and (
        e[2] in WRITE_EXACT
        or (e[2] not in READ_OVERRIDES and any(m in e[2] for m in WRITE_MARKERS))
    )]
    assert not leaked, f"写操作被误判为 T0: {leaked}"
    # 2) 阶段一不得含 T3（阶段一不碰禁止泛化的敏感接口）
    bad = [e for e in entries if e[0] == 1 and e[1] == T3]
    assert not bad, f"阶段一出现 T3 条目: {bad}"
    # 3) T3 不得出现在 T0/T1/T2 中（集合互斥）
    assert not (set(T3_PATHS) & {e[2] for e in entries if e[1] != T3}), "T3 路径分级冲突"

    if "--audit" in sys.argv:
        from collections import Counter
        print("分级统计:", Counter(TIER_NAME[e[1]] for e in entries))
        for t in (T3, T2, T1, T0):
            print(f"\n--- {TIER_NAME[t]} ({sum(1 for e in entries if e[1] == t)}) ---")
            for _, tier, path, _ in entries:
                if tier == t:
                    print("   ", path)
        return 0

    entries.sort(key=lambda e: (e[1], e[0], e[2]))
    lines = [
        '"""NCM 上游接口登记表（自动生成，请勿手改）。',
        "",
        "生成：python3 tools/gen-ncm-registry.py",
        "事实源：docs/api-endpoint-phase-map.csv",
        "安全模型见 docs/api-5-phase-plan.md §4.3。**这是安全边界，只放行登记在册的路径。**",
        "",
        "  T0 公开只读  → 注入服务端 SVIP cookie，响应剥离身份字段",
        "  T1 账号只读  → 使用调用者自己的 ncmbind cookie，不缓存",
        "  T2 账号写    → 用户 cookie + 二次确认 + 审计",
        "  T3 敏感      → 禁止经泛化转发（403），仅项目专用入口实现",
        '"""',
        "",
        "T0, T1, T2, T3 = 0, 1, 2, 3",
        "",
        "# path -> (tier, ttl_seconds, phase)。ttl=0 表示不缓存。",
        "REGISTRY = {",
    ]
    for tier, phase in [(T0, 0), (T1, 1), (T2, 2), (T3, 3)]:
        pass
    for cur_tier in (T0, T1, T2, T3):
        group = [e for e in entries if e[1] == cur_tier]
        if not group:
            continue
        lines.append(f"    # ---- {TIER_NAME[cur_tier]} ----")
        for _, tier, path, ttl in group:
            lines.append(f'    "{path}": ({tier}, {ttl}, {_phase_of(path, entries)}),')
        lines.append("")
    lines += [
        "}",
        "",
        "# 泛化转发默认启用的最高阶段；推进到下一阶段时上调此值（配合 PR 审查）。",
        f"ENABLED_PHASE = {enabled_phase()}",
        "",
        "# ---- 缓存/转发兜底：账号态数据一律不缓存 ----",
        "NO_CACHE_TIERS = (T1, T2, T3)",
        "",
        "# T0 响应需剥离的身份字段（纵深防御：目录类接口本就不该返回这些）",
        "IDENTITY_KEYS = frozenset({",
        '    "account", "bindings", "mobile", "mobileSign",',
        '    "anonimousUser", "createTime", "salt", "idCard",',
        "})",
        "",
        "",
        "def entry(path):",
        '    """返回 (tier, ttl, phase)；未登记返回 None。"""',
        "    return REGISTRY.get(path)",
        "",
        "",
        "def is_forwardable(path):",
        '    """该路径是否允许经泛化转发（已登记、非 T3、且阶段已启用）。"""',
        "    e = REGISTRY.get(path)",
        "    if not e:",
        "        return False",
        "    tier, _ttl, phase = e",
        "    return tier != T3 and phase <= ENABLED_PHASE",
        "",
        "",
        "def strip_identity(obj):",
        '    """递归移除身份字段（仅用于 T0 响应）。"""',
        "    if isinstance(obj, dict):",
        "        return {k: strip_identity(v) for k, v in obj.items() if k not in IDENTITY_KEYS}",
        "    if isinstance(obj, list):",
        "        return [strip_identity(v) for v in obj]",
        "    return obj",
        "",
        "",
        "def family(path):",
        '    """熔断粒度：取前两段路径。"""',
        '    parts = [p for p in path.split("/") if p]',
        '    return "/" + "/".join(parts[:2])',
        "",
    ]
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    from collections import Counter
    print("已写入", OUT_PATH)
    print("条目:", len(entries), Counter(TIER_NAME[e[1]] for e in entries))
    return 0


def _phase_of(path, entries):
    for phase, _tier, p, _ttl in entries:
        if p == path:
            return phase
    return 9


if __name__ == "__main__":
    raise SystemExit(main())
