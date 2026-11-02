#!/usr/bin/env python3
"""前端↔网关契约冒烟：把 UI 实际发起的 /ncm/* 调用逐个打一遍。

用途：A∧B 覆盖里「前端可达」这一半，必须**真的能取到数据**才算数。
本工具列出各阶段 UI 实际使用的调用（含参数），逐个请求并断言返回可用，
从而在没有人肉点页面的情况下发现「接口登记了但前端调用参数不对」这类错位。

用法：
    python3 tools/ncm-smoke.py                                  # 默认阶段一
    python3 tools/ncm-smoke.py --base http://127.0.0.1:3011
    python3 tools/ncm-smoke.py --phase 2
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# 阶段一：发现页「音乐」TAB + 搜索页 + 曲风页实际使用的调用
# 用例：(名称, 路径, 参数, 响应校验函数, 期望 HTTP)
# 账号态接口（T1/T2）未登录时返回 401 属**正确**行为，显式标出以免误判为失败。
SID = 347230   # 测试用歌曲（Beyond - 海阔天空）

PHASE1 = [
    ("发现页 Banner",        "/ncm/banner", {"type": 0},                        lambda d: "banners" in d),
    ("发现页 推荐歌单",       "/ncm/personalized", {"limit": 12},               lambda d: "result" in d),
    ("发现页 推荐新歌",       "/ncm/personalized/newsong", {"limit": 12},       lambda d: "result" in d),
    ("发现页 独家放送",       "/ncm/personalized/privatecontent", {},           lambda d: "result" in d),
    ("发现页 排行榜",         "/ncm/toplist", {},                               lambda d: "list" in d),
    ("发现页 曲风分类",       "/ncm/style/list", {},                            lambda d: "data" in d),
    ("发现页 私人FM节目推荐", "/ncm/personalized/djprogram", {"limit": 6},      lambda d: "result" in d),
    ("发现页 推荐MV",         "/ncm/personalized/mv", {"limit": 6},             lambda d: "result" in d),
    ("发现页 热门歌手",       "/ncm/top/artists", {"limit": 12, "offset": 0},   lambda d: "artists" in d),
    ("发现页 新歌速递",       "/ncm/top/song", {"type": 0, "limit": 20},        lambda d: "data" in d or "result" in d),
    ("曲风页 头部",           "/ncm/style/detail", {"tagId": 1017},             lambda d: "data" in d),
    ("曲风页 歌曲",           "/ncm/style/song", {"tagId": 1017, "size": 30, "cursor": 0},
                                                                               lambda d: (d.get("data") or {}).get("songs") is not None),
    ("曲风页 歌单",           "/ncm/style/playlist", {"tagId": 1017, "size": 30, "cursor": 0},
                                                                               lambda d: (d.get("data") or {}).get("playlist") is not None),
    ("曲风页 歌手",           "/ncm/style/artist", {"tagId": 1017, "size": 30, "cursor": 0},
                                                                               lambda d: (d.get("data") or {}).get("artists") is not None),
    ("曲风页 专辑",           "/ncm/style/album", {"tagId": 1017, "size": 30, "cursor": 0},
                                                                               lambda d: (d.get("data") or {}).get("albums") is not None),
    ("搜索页 热搜详情",       "/ncm/search/hot/detail", {},                     lambda d: "data" in d),
    ("搜索页 搜索建议",       "/ncm/search/suggest", {"keywords": "周杰伦", "type": "mobile"},
                                                                               lambda d: "result" in d or "code" in d),
    ("搜索页 默认关键词",     "/ncm/search/default", {},                        lambda d: "data" in d),
    ("首页 全部榜单",         "/ncm/toplist/detail", {},                        lambda d: "list" in d),
    ("首页 音乐日历",         "/ncm/calendar", {},                             lambda d: "data" in d or "code" in d),
    ("首页 首页发现块",       "/ncm/homepage/block/page", {},                   lambda d: "data" in d),
    ("发现页 精品歌单",       "/ncm/top/playlist/highquality", {"cat": "全部", "limit": 9},
                                                                               lambda d: "playlists" in d),
    ("发现页 新碟上架",       "/ncm/top/album", {"limit": 12},                 lambda d: "weekData" in d),
    ("发现页 MV 排行",        "/ncm/top/mv", {"limit": 12},                    lambda d: "data" in d),
    ("发现页 歌手榜",         "/ncm/toplist/artist", {},                       lambda d: "list" in d),
    ("搜索页 热门搜索(泛化)", "/ncm/search/hot", {},                           lambda d: "hots" in (d.get("result") or {})),
    ("搜索页 建议-PC 回退",   "/ncm/search/suggest/pc", {"keywords": "周杰伦"},
                                                                               lambda d: "suggests" in (d.get("data") or {})),
    # 账号态：未登录 401 是正确行为
    ("首页 每日推荐歌单",     "/ncm/recommend/resource", {},                   lambda d: True, 401),
    ("首页 不感兴趣(写)",     "/ncm/recommend/songs/dislike", {"id": 1, "confirm": 1}, lambda d: True, 401),
    ("发现页 榜单分组 v2",    "/ncm/toplist/detail/v2", {},                     lambda d: "data" in d),
    ("发现页 曲风偏好(需绑定)", "/ncm/style/preference", {},                     lambda d: True, 401),
    ("首页 每日推荐歌曲(需绑定)", "/ncm/recommend/songs", {},                     lambda d: True, 401),
]

# 阶段二：歌曲详情抽屉 / 歌词本 / 下载 / 打卡 / 云盘 / 评论（UI 实际发起的调用）
PHASE2 = [
    ("歌曲详情 音质档位",   "/ncm/song/music/detail", {"id": SID},            lambda d: "data" in d),
    ("歌曲详情 副歌时间",   "/ncm/song/chorus", {"id": SID},                  lambda d: ("chorus" in d or "data" in d)),
    ("歌曲详情 红心数",     "/ncm/song/red/count", {"ids": SID},              lambda d: "count" in (d.get("data") or {})),
    ("歌曲详情 创作者",     "/ncm/song/creators", {"id": SID},                lambda d: "data" in d),
    ("歌曲详情 音乐百科",   "/ncm/song/wiki/info", {"id": SID},               lambda d: "data" in d),
    ("歌曲详情 相似歌曲",   "/ncm/song/simi/get", {"id": SID},                lambda d: "data" in d),
    ("歌曲详情 乐谱",       "/ncm/sheet/list", {"id": SID},                   lambda d: "data" in d),
    ("歌曲详情 评论统计",   "/ncm/comment/info/list", {"id": SID, "type": 0}, lambda d: "data" in d),
    ("评论 歌曲维度",       "/ncm/comment/music", {"id": SID, "type": 0, "limit": 20}, lambda d: True),
    ("下载 客户端链接",     "/ncm/song/download/url/v1", {"id": SID, "level": "exhigh"},
                                                                             lambda d: (d.get("data") or {}).get("url") is not None),
    ("下载 通用链接",       "/ncm/song/download/url", {"id": SID, "br": 320000}, lambda d: "data" in d),
    ("音源 新版",           "/ncm/song/url/v1", {"id": SID, "level": "exhigh"}, lambda d: "data" in d),
    # 通用评论抽屉：6 个维度读取（UI 会按实体传对应 id/type）
    ("评论 歌单维度",       "/ncm/comment/playlist", {"id": 3778678, "type": 2, "limit": 20}, lambda d: "comments" in d),
    ("评论 专辑维度",       "/ncm/comment/album", {"id": 32311, "type": 3, "limit": 20},   lambda d: "comments" in d),
    ("评论 MV 维度",        "/ncm/comment/mv", {"id": 10928277, "type": 1, "limit": 20},   lambda d: "comments" in d),
    ("评论 电台维度",       "/ncm/comment/dj", {"id": 1230174483, "type": 4, "limit": 20}, lambda d: True),
    ("评论 视频维度",       "/ncm/comment/video", {"id": 5501497, "type": 5, "limit": 20}, lambda d: True),
    ("评论 热门",           "/ncm/comment/hot", {"id": SID, "type": 0, "limit": 20},       lambda d: True),
    ("评论 楼层(泛化)",     "/ncm/comment/floor", {"id": SID, "parentCommentId": 5031795, "type": 0, "limit": 10},
                                                                               lambda d: "data" in d),
    ("评论 楼层(老客户端)", "/ncm/comment/floor", {"id": SID, "cid": 5031795},  lambda d: "comments" in d),
    ("评论 抱一抱列表",     "/ncm/comment/hug/list", {"sid": SID, "cid": 5031795, "type": 0}, lambda d: True),
    # 播放地址回退链（地区受限曲目的关键）
    ("音源 解灰直链",       "/ncm/song/url/match", {"id": SID},               lambda d: bool(d.get("data"))),
    ("音源 老接口",         "/ncm/song/url", {"id": SID, "br": 320000},       lambda d: bool(d.get("url"))),
    ("音源 可用性检查",     "/ncm/check/music", {"id": SID},                  lambda d: "success" in d),
    # 歌曲详情扩展
    ("歌曲 其他版本",       "/ncm/song/copyright/rcmd", {"id": SID, "songid": SID}, lambda d: "data" in d),
    ("歌曲 百科简要",       "/ncm/song/wiki/summary", {"id": SID},            lambda d: "data" in d),
    ("歌曲 乐谱谱面",       "/ncm/sheet/preview", {"id": 171018},             lambda d: isinstance(d.get("data"), list)),
    ("歌曲 动态封面",       "/ncm/song/dynamic/cover", {"id": SID},            lambda d: "data" in d),
    # 评论其它排序
    ("评论 最新排序",       "/ncm/comment/new", {"id": SID, "type": 0, "pageNo": 1, "pageSize": 20, "sortType": 2},
                                                                               lambda d: "data" in d or "comments" in d),
    # 账号态：未登录 401 是正确行为
    ("资产 已购单曲",       "/ncm/song/purchased", {"limit": 20, "offset": 0}, lambda d: True, 401),
    ("资产 下载记录",       "/ncm/song/downlist", {"limit": 20, "offset": 0},  lambda d: True, 401),
    ("歌曲 回忆坐标",       "/ncm/music/first/listen/info", {"songId": SID},   lambda d: True, 401),
    ("歌曲 该曲摘录",       "/ncm/song/lyrics/mark", {"id": SID},             lambda d: True, 401),
    ("评论 发表(拆分)",     "/ncm/comment/add", {"id": SID, "type": 0, "content": "x", "confirm": 1}, lambda d: True, 401),
    ("评论 回复(拆分)",     "/ncm/comment/reply", {"id": SID, "type": 0, "cid": 5031795, "content": "x", "confirm": 1}, lambda d: True, 401),
    ("评论 删除(拆分)",     "/ncm/comment/delete", {"id": SID, "type": 0, "cid": 5031795, "confirm": 1}, lambda d: True, 401),
    ("同步红心 新版",       "/ncm/like/v1", {"id": SID, "like": "true", "confirm": 1}, lambda d: True, 401),
    ("分享到动态",          "/ncm/share/resource", {"id": SID, "type": "song", "confirm": 1}, lambda d: True, 401),
    ("打卡 新版",           "/ncm/scrobble/v1", {"id": SID, "time": 30, "confirm": 1}, lambda d: True, 401),
    ("播放状态上报",        "/ncm/relay/play/state/submit", {"id": SID, "progress": 30, "confirm": 1}, lambda d: True, 401),
    ("保存歌单排序(写)",    "/ncm/song/order/update", {"pid": 3778678, "ids": str(SID), "confirm": 1}, lambda d: True, 401),
    ("红心 旧版",           "/ncm/song/like", {"id": SID, "like": "true", "uid": 1, "confirm": 1}, lambda d: True, 401),
    ("歌词本 我的摘录",     "/ncm/song/lyrics/mark/user/page", {},            lambda d: True, 401),
    ("歌词摘录 添加(写)",   "/ncm/song/lyrics/mark/add", {"id": SID, "data": "{}", "confirm": 1}, lambda d: True, 401),
    ("红心列表",            "/ncm/likelist", {},                              lambda d: True, 401),
    ("已购单曲",            "/ncm/song/purchased", {},                        lambda d: True, 401),
    ("云盘(写)",            "/ncm/cloud", {},                                 lambda d: True, 401),
    ("听歌打卡(写)",        "/ncm/scrobble", {"id": SID, "time": 30, "confirm": 1}, lambda d: True, 401),
    ("评论 发表(写)",       "/ncm/comment", {"t": 0, "type": 0, "id": SID, "content": "x", "confirm": 1}, lambda d: True, 401),
    ("评论 点赞(写)",       "/ncm/comment/like", {"id": SID, "cid": 5031795, "type": 0, "t": 0, "confirm": 1}, lambda d: True, 401),
    ("抱一抱(写)",          "/ncm/hug/comment", {"sid": SID, "cid": 5031795, "type": 0, "confirm": 1}, lambda d: True, 401),
    # 阶段三启用后 /album/sub 已是 T2 写操作：未登录返回 401（曾用于验证阶段门禁的 404）
    ("收藏专辑(写)",        "/ncm/album/sub", {"id": 1},                      lambda d: True, 401),
]

PHASES = {1: PHASE1, 2: PHASE1 + PHASE2}

# 阶段三：MV / 视频（UI 实际发起的调用）。
# 上游降级项显式记录，不静默放过：
#   - /video/group  返回 code=200 但 datas 恒为 null（上游无数据，分类页给明确空态）。
VID = "F54F8EC28C8257694DEDA54FB2D516D7"   # 来自 /video/timeline/recommend
MVID = 10929613
AID = 6452                                  # 周杰伦（歌手维度各接口都有数据）
PHASE3 = [
    # MV 列表页
    ("MV 全部",       "/ncm/mv/all", {"area": "全部", "order": "上升最快", "type": "全部", "limit": 30, "offset": 0},
                                                                   lambda d: "data" in d),
    ("MV 最新",       "/ncm/mv/first", {"area": "全部", "limit": 30}, lambda d: "data" in d),
    ("MV 独家推荐",   "/ncm/mv/exclusive/rcmd", {"limit": 30, "offset": 0}, lambda d: "data" in d),
    # MV 详情页
    ("MV 详情",       "/ncm/mv/detail", {"mvid": MVID},             lambda d: "data" in d),
    ("MV 计数",       "/ncm/mv/detail/info", {"mvid": MVID},        lambda d: "likedCount" in d),
    ("MV 播放地址",   "/ncm/mv/url", {"id": MVID, "r": 1080},       lambda d: bool((d.get("data") or {}).get("url"))),
    ("MV 相似",       "/ncm/simi/mv", {"mvid": MVID},               lambda d: "mvs" in d),
    ("MV 同曲 MLOG",  "/ncm/mlog/music/rcmd", {"mvid": MVID, "limit": 6},
                                                                   lambda d: ((d.get("data") or {}).get("feeds") is not None)),
    # 视频广场
    ("视频 推荐流",   "/ncm/video/timeline/recommend", {"offset": 0}, lambda d: "datas" in d),
    ("视频 最新流",   "/ncm/video/timeline/all", {"offset": 0},     lambda d: "datas" in d),
    ("视频 分类清单", "/ncm/video/category/list", {"limit": 30, "offset": 0}, lambda d: "data" in d),
    ("视频 分组清单", "/ncm/video/group/list", {},                  lambda d: "data" in d),
    ("视频 分组内容(降级)", "/ncm/video/group", {"id": 58100, "offset": 0}, lambda d: "code" in d),
    # 视频详情页
    # 参数名是 id 不是 vid（上游两个接口不一致，这里钉死，防止再传错）
    ("视频 详情",     "/ncm/video/detail", {"id": VID},             lambda d: bool((d.get("data") or {}).get("vid"))),
    ("视频 计数",     "/ncm/video/detail/info", {"vid": VID},       lambda d: "likedCount" in d),
    ("视频 播放地址", "/ncm/video/url", {"id": VID},                lambda d: bool((d.get("urls") or [{}])[0].get("url"))),
    ("视频 相关",     "/ncm/related/allvideo", {"id": VID},         lambda d: "data" in d),
    # 账号态：未登录 401 是正确行为
    ("MV 收藏列表",   "/ncm/mv/sublist", {"limit": 30, "offset": 0}, lambda d: True, 401),
    ("MV 收藏(写)",   "/ncm/mv/sub", {"mvid": MVID, "t": 1, "confirm": 1}, lambda d: True, 401),
    ("MV 百科(需绑定)", "/ncm/ugc/mv/get", {"id": MVID},             lambda d: True, 401),
    ("视频 收藏(写)", "/ncm/video/sub", {"id": VID, "t": 1, "confirm": 1}, lambda d: True, 401),
    # 歌手页扩展（阶段三）
    ("歌手 简介",     "/ncm/artist/desc", {"id": AID},              lambda d: "introduction" in d),
    ("歌手 详情",     "/ncm/artist/detail", {"id": AID},            lambda d: "data" in d),
    ("歌手 动态",     "/ncm/artist/detail/dynamic", {"id": AID},    lambda d: "code" in d),
    ("歌手 粉丝榜",   "/ncm/artist/fans", {"id": AID, "limit": 30, "offset": 0}, lambda d: "data" in d),
    ("歌手 关注数",   "/ncm/artist/follow/count", {"id": AID},      lambda d: "fansCnt" in (d.get("data") or {})),
    ("歌手 热门作品", "/ncm/artist/top/song", {"id": AID},          lambda d: "songs" in d),
    ("歌手 MV",       "/ncm/artist/mv", {"id": AID, "limit": 9, "offset": 0}, lambda d: "mvs" in d),
    ("歌手 视频",     "/ncm/artist/video", {"id": AID, "size": 9, "cursor": 0, "order": 0},
                                                                   lambda d: "data" in d),
    ("歌手 相似",     "/ncm/simi/artist", {"id": AID},              lambda d: "artists" in d),
    ("歌手 分类浏览", "/ncm/artist/list", {"type": -1, "area": -1, "initial": -1, "limit": 30, "offset": 0},
                                                                   lambda d: "artists" in d),
    # 关注歌手的新歌/新 MV：账号态，未登录 401 是正确行为
    ("歌手 关注新歌(需绑定)", "/ncm/artist/new/song", {"limit": 10}, lambda d: True, 401),
    ("歌手 关注新MV(需绑定)", "/ncm/artist/new/mv", {"limit": 10},  lambda d: True, 401),
    ("歌手 新歌MV流(需绑定)", "/ncm/artist/new/song/mv/list/v2", {"limit": 10, "before": 0}, lambda d: True, 401),
    ("歌手 新歌全播(需绑定)", "/ncm/artist/new/song/playall", {},   lambda d: True, 401),
    # 新碟 / 数字专辑（阶段三）
    ("新碟 分地区",   "/ncm/album/new", {"area": "ALL", "limit": 24, "offset": 0}, lambda d: "albums" in d),
    ("新碟 最新",     "/ncm/album/newest", {},                      lambda d: "albums" in d),
    ("数字专辑 在售", "/ncm/album/list", {"area": "Z_H", "limit": 24, "offset": 0}, lambda d: "products" in d),
    ("数字专辑 风格馆", "/ncm/album/list/style", {"area": "Z_H", "limit": 24, "offset": 0},
                                                                   lambda d: "albumProducts" in d),
    # 销量榜 type 只认 daily/week/year/total（写成 yearly 上游 404），只有 year 带 year 参数
    ("数字专辑 销量榜", "/ncm/album/songsaleboard", {"albumType": 0, "type": "daily"}, lambda d: "products" in d),
    # /album/detail 是数字专辑详情，id 必须来自 /album/list 的 albumId（传音乐专辑 id 会 404）
    ("数字专辑 详情", "/ncm/album/detail", {"id": 394453761},       lambda d: "product" in d),
    ("专辑 播放权限", "/ncm/album/privilege", {"id": 32311},        lambda d: "data" in d),
    ("专辑 收藏列表(需绑定)", "/ncm/album/sublist", {"limit": 25, "offset": 0}, lambda d: True, 401),
    # 相似维度
    ("相似歌曲",      "/ncm/simi/song", {"id": SID, "limit": 10, "offset": 0}, lambda d: "songs" in d),
    ("相似歌单(上游常空)", "/ncm/simi/playlist", {"id": 805407063, "limit": 6, "offset": 0}, lambda d: "playlists" in d),
    ("相似用户(上游常空)", "/ncm/simi/user", {"id": 261607535, "limit": 12, "offset": 0}, lambda d: "userprofiles" in d),
    # 歌单广场 / 编辑器（读）
    ("歌单 分类清单", "/ncm/playlist/catlist", {},                  lambda d: "sub" in d),
    ("歌单 分类浏览", "/ncm/playlist/category/list", {"cat": "全部", "limit": 30, "offset": 0}, lambda d: "playlists" in d),
    ("歌单 精品标签", "/ncm/playlist/highquality/tags", {},         lambda d: "tags" in d),
    ("歌单 热门标签", "/ncm/playlist/hot", {},                      lambda d: "tags" in d),
    ("歌单 动态计数", "/ncm/playlist/detail/dynamic", {"id": 3778678}, lambda d: "code" in d),
    ("歌单 相似推荐", "/ncm/playlist/detail/rcmd/get", {"id": 3778678}, lambda d: "code" in d),
    ("歌单 订阅者",   "/ncm/playlist/subscribers", {"id": 3778678, "limit": 50, "offset": 0},
                                                                   lambda d: "subscribers" in d),
    # 歌单写操作（T2）：未登录 401 是正确行为；带上 confirm=1，免得被 T2 门禁先拦成 400
    ("歌单 新建(写)", "/ncm/playlist/create", {"name": "smoke", "privacy": 0, "confirm": 1}, lambda d: True, 401),
    ("歌单 更新(写)", "/ncm/playlist/update", {"id": 3778678, "name": "x", "confirm": 1}, lambda d: True, 401),
    ("歌单 改名(写)", "/ncm/playlist/name/update", {"id": 3778678, "name": "x", "confirm": 1}, lambda d: True, 401),
    ("歌单 改简介(写)", "/ncm/playlist/desc/update", {"id": 3778678, "desc": "x", "confirm": 1}, lambda d: True, 401),
    ("歌单 改标签(写)", "/ncm/playlist/tags/update", {"id": 3778678, "tags": "x", "confirm": 1}, lambda d: True, 401),
    ("歌单 隐私(写)", "/ncm/playlist/privacy", {"id": 3778678, "confirm": 1}, lambda d: True, 401),
    ("歌单 收藏(写)", "/ncm/playlist/subscribe", {"id": 3778678, "t": 1, "confirm": 1}, lambda d: True, 401),
    ("歌单 加歌(写)", "/ncm/playlist/track/add", {"pid": 3778678, "ids": str(SID), "confirm": 1}, lambda d: True, 401),
    ("歌单 删歌(写)", "/ncm/playlist/track/delete", {"id": 3778678, "ids": str(SID), "confirm": 1}, lambda d: True, 401),
    ("歌单 排序(写)", "/ncm/playlist/order/update", {"ids": str(SID), "confirm": 1}, lambda d: True, 401),
    ("歌单 批量(写)", "/ncm/playlist/tracks", {"op": "add", "pid": 3778678, "tracks": "[]", "confirm": 1}, lambda d: True, 401),
    ("歌单 删除(写)", "/ncm/playlist/delete", {"id": 3778678, "confirm": 1}, lambda d: True, 401),
    ("歌单 播放上报(写)", "/ncm/playlist/update/playcount", {"id": 3778678, "confirm": 1}, lambda d: True, 401),
    ("歌单 导入(写)", "/ncm/playlist/import/name/task/create", {"link": "https://music.163.com/playlist?id=1", "confirm": 1},
                                                                   lambda d: True, 401),
    ("歌单 导入进度(需绑定)", "/ncm/playlist/import/task/status", {"id": 1}, lambda d: True, 401),
    ("歌单 我的收藏(需绑定)", "/ncm/playlist/mylike", {"limit": 30, "time": 0}, lambda d: True, 401),
    ("歌单 最近视频(需绑定)", "/ncm/playlist/video/recent", {},      lambda d: True, 401),
    # 唯一的 multipart 上传接口（白名单见 cm_ncm_gateway.UPLOAD_FIELD）：
    # 未绑定时应在**解码文件之前**就被 T2 门禁拦下（不浪费解码、不把字节转发给上游）
    ("歌单 换封面(需绑定)", "/ncm/playlist/cover/update", {"id": 3778678, "confirm": 1},
     lambda d: True, 401, "POST", {"file": "iVBORw0KGgo=", "filename": "c.png", "contentType": "image/png"}),
    # 百科 UGC（全部 T1）
    ("百科 我的贡献(需绑定)", "/ncm/ugc/detail", {"type": 1, "limit": 20, "offset": 0}, lambda d: True, 401),
    ("百科 歌曲词条(需绑定)", "/ncm/ugc/song/get", {"id": SID},      lambda d: True, 401),
    ("百科 歌手词条(需绑定)", "/ncm/ugc/artist/get", {"id": AID},    lambda d: True, 401),
    ("百科 歌手搜索(需绑定)", "/ncm/ugc/artist/search", {"keyword": "周杰伦"}, lambda d: True, 401),
    ("百科 贡献统计(需绑定)", "/ncm/ugc/user/devote", {},            lambda d: True, 401),
]

# 阶段四：账号 / 社交 / 听歌足迹。这一阶段 T1 占多数，未绑定网易云时
# 一律 401「请先绑定网易云账号后再使用该功能」——那正是**正确**行为，用例按 401 断言。
PHASE4 = [
    # 听歌足迹（pages/footprint.js）
    ("足迹 累计时长",   "/ncm/listen/data/total", {},               lambda d: True, 401),
    ("足迹 周报",       "/ncm/listen/data/report", {"type": "week"}, lambda d: True, 401),
    ("足迹 实时统计",   "/ncm/listen/data/realtime/report", {"type": "week"}, lambda d: True, 401),
    ("足迹 今日歌曲",   "/ncm/listen/data/today/song", {},          lambda d: True, 401),
    ("足迹 播放排行",   "/ncm/listen/data/song/play/rank", {"type": "week"}, lambda d: True, 401),
    ("足迹 年度报告",   "/ncm/listen/data/year/report", {"year": 2025}, lambda d: True, 401),
    ("足迹 最近常听",   "/ncm/recent/listen/list", {"limit": 12},   lambda d: True, 401),
    ("足迹 历史日推",   "/ncm/history/recommend/songs", {},         lambda d: True, 401),
    ("足迹 日推详情",   "/ncm/history/recommend/songs/detail", {"date": "2026-09-29"}, lambda d: True, 401),
    ("足迹 年度总结(上游404)", "/ncm/summary/annual", {"year": 2025, "uid": 1}, lambda d: True, 401),
    ("足迹 最近播放-歌曲", "/ncm/record/recent/song", {"limit": 50}, lambda d: True, 401),
    ("足迹 最近播放-歌单", "/ncm/record/recent/playlist", {"limit": 50}, lambda d: True, 401),
    ("足迹 最近播放-专辑", "/ncm/record/recent/album", {"limit": 50}, lambda d: True, 401),
    ("足迹 最近播放-电台", "/ncm/record/recent/dj", {"limit": 50}, lambda d: True, 401),
    ("足迹 最近播放-视频", "/ncm/record/recent/video", {"limit": 50}, lambda d: True, 401),
    ("足迹 最近播放-播客", "/ncm/record/recent/voice", {"limit": 50}, lambda d: True, 401),
    ("足迹 播放记录",   "/ncm/user/record", {"uid": 1, "type": 0}, lambda d: True, 401),
    ("足迹 我的歌单",   "/ncm/user/playlist", {"uid": 1, "limit": 100, "offset": 0}, lambda d: True, 401),
    ("足迹 收藏的歌单", "/ncm/user/playlist/collect", {"uid": 1, "limit": 50, "offset": 0}, lambda d: True, 401),
    ("足迹 创建的歌单", "/ncm/user/playlist/create", {"uid": 1, "limit": 50, "offset": 0}, lambda d: True, 401),
    # 消息与私信（pages/messages.js）
    ("消息 私信列表",   "/ncm/msg/private", {"limit": 30, "offset": 0}, lambda d: True, 401),
    ("消息 聊天记录",   "/ncm/msg/private/history", {"uid": 1, "limit": 30, "before": 0}, lambda d: True, 401),
    ("消息 评论我的",   "/ncm/msg/comments", {"uid": 1, "limit": 20, "before": 0}, lambda d: True, 401),
    ("消息 通知",       "/ncm/msg/notices", {"limit": 20, "lasttime": 0}, lambda d: True, 401),
    ("消息 转发我的",   "/ncm/msg/forwards", {"limit": 30, "offset": 0}, lambda d: True, 401),
    ("消息 最近联系人", "/ncm/msg/recentcontact", {},               lambda d: True, 401),
    ("消息 未读数",     "/ncm/pl/count", {},                        lambda d: True, 401),
    ("消息 发文本(写)", "/ncm/send/text", {"user_ids": "[1]", "msg": "smoke", "confirm": 1}, lambda d: True, 401),
    ("消息 发歌曲(写)", "/ncm/send/song", {"id": SID, "user_ids": "[1]", "msg": "smoke", "confirm": 1}, lambda d: True, 401),
    ("消息 发专辑(写)", "/ncm/send/album", {"id": 32311, "user_ids": "[1]", "msg": "smoke", "confirm": 1}, lambda d: True, 401),
    ("消息 发歌单(写)", "/ncm/send/playlist", {"playlist": 3778678, "user_ids": "[1]", "msg": "smoke", "confirm": 1}, lambda d: True, 401),
    # 关注与用户状态（pages/follow.js）
    ("关系 我的关注",   "/ncm/user/follows", {"uid": 1, "limit": 30, "offset": 0}, lambda d: True, 401),
    ("关系 我的粉丝",   "/ncm/user/followeds", {"uid": 1, "limit": 30, "offset": 0}, lambda d: True, 401),
    ("关系 混合关注",   "/ncm/user/follow/mixed", {"cursor": 0, "scene": 0, "size": 30}, lambda d: True, 401),
    ("关系 昵称查ID",   "/ncm/get/userids", {"nicknames": "周杰伦"}, lambda d: True, 401),
    ("关系 是否互关",   "/ncm/user/mutualfollow/get", {"uid": 1},    lambda d: True, 401),
    ("关系 关注(写)",   "/ncm/follow", {"id": 1, "t": 1, "confirm": 1}, lambda d: True, 401),
    ("关系 当前状态",   "/ncm/user/social/status", {"uid": 1},       lambda d: True, 401),
    ("关系 设置状态(写)", "/ncm/user/social/status/edit", {"content": "smoke", "type": "LISTENING", "confirm": 1}, lambda d: True, 401),
    ("关系 状态推荐",   "/ncm/user/social/status/rcmd", {},          lambda d: True, 401),
    ("关系 可用状态",   "/ncm/user/social/status/support", {},       lambda d: True, 401),
    ("关系 用户详情",   "/ncm/user/detail", {"uid": 1},              lambda d: True, 401),
    # 动态与话题（pages/events.js）：/topic/detail* 是 T0 公开只读（无需登录），其余账号态
    ("动态 广场(需绑定)", "/ncm/event", {"pagesize": 20, "lasttime": 0}, lambda d: True, 401),
    ("动态 我订阅的话题(需绑定)", "/ncm/topic/sublist", {"limit": 30, "offset": 0}, lambda d: True, 401),
    ("动态 我的动态(需绑定)", "/ncm/user/event", {"uid": 1, "limit": 30, "lasttime": 0}, lambda d: True, 401),
    ("动态 我的全部动态(需绑定)", "/ncm/user/event/all", {},          lambda d: True, 401),
    ("动态 评论历史(需绑定)", "/ncm/user/comment/history", {"uid": 1, "limit": 20, "time": 0}, lambda d: True, 401),
    ("动态 转发(写)",   "/ncm/event/forward", {"evId": 1, "uid": 1, "forwards": "[]", "confirm": 1}, lambda d: True, 401),
    ("动态 删除(写)",   "/ncm/event/del", {"evId": 1, "confirm": 1}, lambda d: True, 401),
    ("动态 隐私(写)",   "/ncm/event/privacy", {"evId": 1, "privacy": 0, "confirm": 1}, lambda d: True, 401),
    # T0：公开只读，未登录也应 200
    ("话题 详情(T0 公开)", "/ncm/topic/detail", {"actid": 111873100}, lambda d: "act" in d),
    ("话题 热动态(T0 公开)", "/ncm/topic/detail/event/hot", {"actid": 111873100}, lambda d: "events" in d),
    # 账号资料 / 签到 / 设备（pages/account.js）
    ("账号 账号本体",   "/ncm/user/account", {},                    lambda d: True, 401),
    ("账号 资料新版",   "/ncm/user/detail/new", {"uid": 1},         lambda d: True, 401),
    ("账号 等级",       "/ncm/user/level", {},                      lambda d: True, 401),
    ("账号 勋章",       "/ncm/user/medal", {"uid": 1},              lambda d: True, 401),
    ("账号 收藏统计",   "/ncm/user/subcount", {},                   lambda d: True, 401),
    ("账号 绑定关系",   "/ncm/user/binding", {"uid": 1},            lambda d: True, 401),
    ("账号 昵称查重",   "/ncm/nickname/check", {"nickname": "smoke"}, lambda d: True, 401),
    ("账号 手机号检测", "/ncm/cellphone/existence/check", {"cellphone": "13800000000"}, lambda d: True, 401),
    ("账号 改资料(写)", "/ncm/user/update", {"nickname": "smoke", "confirm": 1}, lambda d: True, 401),
    ("账号 初始化昵称(写)", "/ncm/activate/init/profile", {"nickname": "smoke", "confirm": 1}, lambda d: True, 401),
    # 换头像：走 multipart 上传通道（与 /playlist/cover/update 同一条白名单）
    ("账号 换头像(需绑定)", "/ncm/avatar/upload", {},
     lambda d: True, 401, "POST", {"file": "iVBORw0KGgo=", "filename": "a.png", "contentType": "image/png"}),
    ("账号 签到活动",   "/ncm/sign/happy/info", {},                 lambda d: True, 401),
    ("账号 签到进度",   "/ncm/signin/progress", {"moduleId": 0},    lambda d: True, 401),
    ("账号 签到(写)",   "/ncm/daily_signin", {"type": 0, "confirm": 1}, lambda d: True, 401),
    ("账号 设备列表",   "/ncm/device/list", {},                     lambda d: True, 401),
    ("账号 设备下线(写)", "/ncm/device/kickoff", {"deviceKey": "x", "confirm": 1}, lambda d: True, 401),
    ("账号 设备上报(写)", "/ncm/deviceinfo/center/upload", {"deviceName": "smoke", "name": "smoke", "confirm": 1}, lambda d: True, 401),
    # 音乐云盘与电台（pages/cloud.js）
    ("云盘 列表",       "/ncm/user/cloud", {"limit": 50, "offset": 0}, lambda d: True, 401),
    ("云盘 单曲详情",   "/ncm/user/cloud/detail", {"id": "1"},       lambda d: True, 401),
    ("云盘 下载直链",   "/ncm/song/cloud/download", {"id": "1"},     lambda d: True, 401),
    ("云盘 歌词",       "/ncm/cloud/lyric/get", {"sid": "1", "uid": 1}, lambda d: True, 401),
    ("云盘 匹配纠正(写)", "/ncm/cloud/match", {"sid": "1", "asid": "1", "uid": 1, "confirm": 1}, lambda d: True, 401),
    ("云盘 删除(写)",   "/ncm/user/cloud/del", {"id": "1", "confirm": 1}, lambda d: True, 401),
    ("云盘 我的电台",   "/ncm/user/dj", {"uid": 1, "limit": 50, "offset": 0}, lambda d: True, 401),
    ("云盘 我的音频",   "/ncm/user/audio", {"uid": 1},               lambda d: True, 401),
]

# 阶段五：音频生态与增值长尾。先覆盖电台（DJ）簇——它是本阶段最大的一块（30 条）。
# T0 是公开目录（未登录也应 200），T1/T2 是账号态（未绑定一律 401）。
PHASE5 = [
    ("电台 推荐",       "/ncm/dj/recommend", {},                    lambda d: True),
    ("电台 为你推荐",   "/ncm/dj/personalize/recommend", {"limit": 6}, lambda d: True),
    ("电台 Banner",     "/ncm/dj/banner", {},                       lambda d: True),
    ("电台 分类精选",   "/ncm/dj/recommend/type", {"type": 0},       lambda d: True),
    ("电台 今日优选",   "/ncm/dj/today/perfered", {"page": 1},       lambda d: True),
    ("电台 分类清单",   "/ncm/dj/catelist", {},                      lambda d: True),
    ("电台 分类电台",   "/ncm/dj/radio/hot", {"cateId": 0, "limit": 30, "offset": 0}, lambda d: True),
    ("电台 热门",       "/ncm/dj/hot", {"limit": 6, "offset": 0},    lambda d: True),
    ("电台 分类推荐",   "/ncm/dj/category/recommend", {},            lambda d: True),
    ("电台 新晋分类",   "/ncm/dj/category/excludehot", {},           lambda d: True),
    ("电台 榜单",       "/ncm/dj/toplist", {"limit": 30, "offset": 0, "type": "hot"}, lambda d: True),
    ("电台 新人榜",     "/ncm/dj/toplist/newcomer", {"limit": 30, "offset": 0}, lambda d: True),
    ("电台 流行榜",     "/ncm/dj/toplist/popular", {"limit": 30},    lambda d: True),
    ("电台 付费榜",     "/ncm/dj/toplist/pay", {"limit": 30},        lambda d: True),
    ("电台 24小时榜",   "/ncm/dj/toplist/hours", {"limit": 30},      lambda d: True),
    ("电台 节目榜",     "/ncm/dj/program/toplist", {"limit": 30, "offset": 0}, lambda d: True),
    ("电台 节目小时榜", "/ncm/dj/program/toplist/hours", {"limit": 30}, lambda d: True),
    ("电台 djRadio榜",  "/ncm/djRadio/top", {"dataType": 1, "dataGapDays": 7, "sortIndex": 0}, lambda d: True),
    ("电台 赞助榜",     "/ncm/dj/paygift", {"limit": 6, "offset": 0}, lambda d: True),
    ("电台 详情",       "/ncm/dj/detail", {"rid": 1230174483},       lambda d: "data" in d),
    ("电台 节目列表",   "/ncm/dj/program", {"rid": 1230174483, "limit": 30, "offset": 0, "asc": "false"}, lambda d: "programs" in d),
    # 参数是**节目 id**（programs[].id），不是 mainSong.id —— 传成歌曲 id 上游会 404
    ("电台 节目详情",   "/ncm/dj/program/detail", {"id": 3729421207}, lambda d: "program" in d),
    ("电台 数字频道",   "/ncm/dj/difm/all/style/channel", {"sources": "[0]"}, lambda d: True),
    ("电台 数字在播",   "/ncm/dj/difm/playing/tracks/list", {"channelId": 0, "limit": 10, "source": 0}, lambda d: True),
    # 账号态
    ("电台 我的订阅(需绑定)", "/ncm/dj/sublist", {"limit": 30, "offset": 0}, lambda d: True, 401),
    ("电台 订阅者(需绑定)", "/ncm/dj/subscriber", {"id": 1230174483, "limit": 30, "time": 0}, lambda d: True, 401),
    ("电台 已订频道(需绑定)", "/ncm/dj/difm/subscribe/channels/get", {}, lambda d: True, 401),
    ("电台 订阅(写)",   "/ncm/dj/sub", {"rid": 1230174483, "t": 1, "confirm": 1}, lambda d: True, 401),
    ("电台 频道订阅(写)", "/ncm/dj/difm/channel/subscribe", {"channelId": 0, "confirm": 1}, lambda d: True, 401),
    ("电台 频道退订(写)", "/ncm/dj/difm/channel/unsubscribe", {"channelId": 0, "confirm": 1}, lambda d: True, 401),
    # 播客 / 广播 / 私人 FM（pages/podcast.js）
    ("播客 搜索",       "/ncm/voicelist/search", {"keyword": "晚安", "limit": 5, "offset": 0}, lambda d: True),
    ("播客 节目推荐",   "/ncm/program/recommend", {"limit": 5, "offset": 0, "type": 0}, lambda d: True),
    ("播客 列表(限owner)", "/ncm/voicelist/list", {"voiceListId": 0, "limit": 5, "offset": 0}, lambda d: True),
    ("播客 详情(限owner)", "/ncm/voicelist/detail", {"id": 1},     lambda d: True),
    ("播客 列表搜索",   "/ncm/voicelist/list/search", {"name": "晚安", "limit": 5, "offset": 0, "type": 0}, lambda d: True),
    ("播客 声音详情",   "/ncm/voice/detail", {"id": 1},             lambda d: True),
    ("播客 声音歌词",   "/ncm/voice/lyric", {"id": 1},              lambda d: True),
    ("广播 分类地区",   "/ncm/broadcast/category/region/get", {},   lambda d: True),
    ("广播 电台列表",   "/ncm/broadcast/channel/list", {"limit": 5}, lambda d: True),
    ("广播 在播信息",   "/ncm/broadcast/channel/currentinfo", {"id": 1069201}, lambda d: True),
    # 账号态
    ("播客 我的播客(需绑定)", "/ncm/voicelist/my/created", {"limit": 50}, lambda d: True, 401),
    ("广播 我收藏的(需绑定)", "/ncm/broadcast/channel/collect/list", {"limit": 30}, lambda d: True, 401),
    ("FM 私人FM(需绑定)", "/ncm/personal_fm", {},                   lambda d: True, 401),
    ("FM 模式(需绑定)", "/ncm/personal/fm/mode", {"mode": "Standard", "submode": "NORMAL", "limit": 1}, lambda d: True, 401),
    ("FM 场景推荐(需绑定)", "/ncm/aidj/content/rcmd", {"latitude": 39.9, "longitude": 116.4}, lambda d: True, 401),
    ("FM 智能续播(需绑定)", "/ncm/playmode/intelligence/list", {"id": 347230, "sid": 347230, "pid": ""}, lambda d: True, 401),
    ("FM 运动电台(需绑定)", "/ncm/radio/sport/get", {"bpm": 120},   lambda d: True, 401),
    ("FM 垃圾桶(写)",   "/ncm/fm_trash", {"id": 347230, "time": 0, "confirm": 1}, lambda d: True, 401),
    ("播客 转文字(写)", "/ncm/voicelist/trans", {"programId": 1, "radioId": 1, "limit": 100, "offset": 0, "position": 0, "confirm": 1}, lambda d: True, 401),
    ("播客 删除声音(写)", "/ncm/voice/delete", {"ids": "[1]", "confirm": 1}, lambda d: True, 401),
    ("广播 订阅(写)",   "/ncm/broadcast/sub", {"id": 1069201, "t": 1, "confirm": 1}, lambda d: True, 401),
    # 声音上传：走 multipart 白名单（字段 songFile）
    ("播客 上传声音(需绑定)", "/ncm/voice/upload", {"voiceListId": 1, "songName": "smoke", "confirm": 1},
     lambda d: True, 401, "POST", {"file": "SUQzBAAAAAA=", "filename": "a.mp3", "contentType": "audio/mpeg"}),
    # 会员 / 云贝 / 音乐人 / 粉丝中心 / 广告（pages/member.js）——除标注外均 T1（未绑定 401）
    ("会员 信息",       "/ncm/vip/info", {"uid": 1},                lambda d: True, 401),
    ("会员 信息v2",     "/ncm/vip/info/v2", {"uid": 1},             lambda d: True, 401),
    ("会员 成长值",     "/ncm/vip/growthpoint", {},                 lambda d: True, 401),
    ("会员 成长值明细", "/ncm/vip/growthpoint/details", {"limit": 10, "offset": 0}, lambda d: True, 401),
    ("会员 任务",       "/ncm/vip/tasks", {},                       lambda d: True, 401),
    ("会员 任务v1",     "/ncm/vip/tasks/v1", {"id": 0},             lambda d: True, 401),
    ("会员 时光机",     "/ncm/vip/timemachine", {"limit": 6},       lambda d: True, 401),
    ("会员 签到状态",   "/ncm/vip/sign/info", {},                   lambda d: True, 401),
    ("会员 签到明细",   "/ncm/vip/sign/detail", {"timestamp": 0},   lambda d: True, 401),
    ("会员 签到历史",   "/ncm/vip/sign/history", {"type": 0},       lambda d: True, 401),
    ("会员 签到(写)",   "/ncm/vip/sign", {"confirm": 1},            lambda d: True, 401),
    ("会员 领取成长值(写)", "/ncm/vip/growthpoint/get", {"ids": "", "confirm": 1}, lambda d: True, 401),
    ("会员 一键领取(写)", "/ncm/vip/growthpoint/getall", {"confirm": 1}, lambda d: True, 401),
    ("云贝 信息",       "/ncm/yunbei/info", {},                     lambda d: True, 401),
    ("云贝 今日",       "/ncm/yunbei/today", {},                    lambda d: True, 401),
    ("云贝 支出",       "/ncm/yunbei/expense", {"limit": 10, "offset": 0}, lambda d: True, 401),
    ("云贝 收入",       "/ncm/yunbei/receipt", {"limit": 10, "offset": 0}, lambda d: True, 401),
    ("云贝 任务",       "/ncm/yunbei/tasks", {},                    lambda d: True, 401),
    ("云贝 任务v1",     "/ncm/yunbei/task/list/v1", {},             lambda d: True, 401),
    ("云贝 待办",       "/ncm/yunbei/tasks/todo", {},               lambda d: True, 401),
    ("云贝 推歌历史",   "/ncm/yunbei/rcmd/song/history", {"cursor": 0, "size": 10}, lambda d: True, 401),
    ("云贝 推歌任务",   "/ncm/yunbei/task/recommend/song", {"limit": 3, "offset": 0}, lambda d: True, 401),
    ("云贝 签到(写)",   "/ncm/yunbei/sign", {"confirm": 1},         lambda d: True, 401),
    ("云贝 完成任务(写)", "/ncm/yunbei/task/finish", {"userTaskId": "", "depositCode": "", "confirm": 1}, lambda d: True, 401),
    ("云贝 完成任务v1(写)", "/ncm/yunbei/task/finish/v1", {"yunbeiAmount": 0, "confirm": 1}, lambda d: True, 401),
    ("云贝 推歌(写)",   "/ncm/yunbei/rcmd/song", {"id": 347230, "yunbeiNum": 10, "confirm": 1}, lambda d: True, 401),
    ("音乐人 云豆",     "/ncm/musician/cloudbean", {},              lambda d: True, 401),
    ("音乐人 数据概况", "/ncm/musician/data/overview", {},          lambda d: True, 401),
    ("音乐人 播放趋势", "/ncm/musician/play/trend", {"startTime": 0, "endTime": 0}, lambda d: True, 401),
    ("音乐人 任务",     "/ncm/musician/tasks", {},                  lambda d: True, 401),
    ("音乐人 新任务",   "/ncm/musician/tasks/new", {},              lambda d: True, 401),
    ("音乐人 VIP任务",  "/ncm/musician/vip/tasks", {},              lambda d: True, 401),
    ("音乐人 领取云豆(写)", "/ncm/musician/cloudbean/obtain", {"id": "", "period": "", "confirm": 1}, lambda d: True, 401),
    ("音乐人 签到(写)", "/ncm/musician/sign", {"confirm": 1},       lambda d: True, 401),
    ("粉丝 年龄画像",   "/ncm/fanscenter/basicinfo/age/get", {},    lambda d: True, 401),
    ("粉丝 性别画像",   "/ncm/fanscenter/basicinfo/gender/get", {}, lambda d: True, 401),
    ("粉丝 地区画像",   "/ncm/fanscenter/basicinfo/province/get", {}, lambda d: True, 401),
    ("粉丝 概况",       "/ncm/fanscenter/overview/get", {},         lambda d: True, 401),
    ("粉丝 趋势",       "/ncm/fanscenter/trend/list", {"type": 0, "startTime": 0, "endTime": 0}, lambda d: True, 401),
    # /ad/get 是 T0 公开只读（未登录也应 200）——曾被我错标成 401，冒烟直接抓出来了
    ("广告 位(T0 公开)", "/ncm/ad/get", {"type_ids": ""},            lambda d: True, 200),
    ("广告 听歌权益",   "/ncm/ad/listening/rights", {},             lambda d: True, 401),
    ("广告 领权益(写)", "/ncm/ad/listening/rights/gain", {"rightsGainType": 0, "gainMethodStep": 0, "source": "web", "confirm": 1}, lambda d: True, 401),
    # 云小编 / 审核 / 抽奖（pages/rep.js）——账号态
    ("云小编 资料",     "/ncm/rep/ugc/user/get", {},                lambda d: True, 401),
    ("云小编 会员",     "/ncm/rep/ugc/user/vip", {},                lambda d: True, 401),
    ("云小编 领会员(写)", "/ncm/rep/ugc/user/collect-vip", {"confirm": 1}, lambda d: True, 401),
    ("云小编 签到(写)", "/ncm/rep/ugc/user/sign", {"confirm": 1},   lambda d: True, 401),
    ("云小编 活动",     "/ncm/rep/ugc/activity/get", {},            lambda d: True, 401),
    ("云小编 报名(写)", "/ncm/rep/ugc/activity/collect", {"activityId": 0, "confirm": 1}, lambda d: True, 401),
    ("云小编 考核信息", "/ncm/rep/ugc/exam/info/get", {"examType": 1}, lambda d: True, 401),
    ("云小编 取题",     "/ncm/rep/ugc/exam/question/single/get", {"examType": 1, "taskId": ""}, lambda d: True, 401),
    ("云小编 考核结果", "/ncm/rep/ugc/exam/result/get", {"examType": 1, "taskId": ""}, lambda d: True, 401),
    ("云小编 开始考核(写)", "/ncm/rep/ugc/exam/start", {"examType": 1, "confirm": 1}, lambda d: True, 401),
    ("云小编 交卷(写)", "/ncm/rep/ugc/exam/submit", {"examType": 1, "taskId": "", "questionId": "", "answer": "x", "confirm": 1}, lambda d: True, 401),
    ("云小编 抽奖机会", "/ncm/middle/play/lottery/remain/chance", {"activityId": 0}, lambda d: True, 401),
    ("云小编 抽奖(写)", "/ncm/middle/play/do/lottery", {"activityId": 0, "drawCount": 1, "confirm": 1}, lambda d: True, 401),
    ("审核 待审详情",   "/ncm/thinktank/audit/resource/detail", {"type": 1}, lambda d: True, 401),
    ("审核 提交(写)",   "/ncm/thinktank/audit/resource/update", {"taskId": "", "type": 1, "judgement": 1, "confirm": 1}, lambda d: True, 401),
    # 助眠 / 话题热榜 / 服务信息（pages/services.js）
    ("助眠 标签(T0)",   "/ncm/sati/tag/list", {},                   lambda d: True, 200),
    # 这两条是 T0 公开只读（未登录也 200）——与"助眠内容需要绑定"的产品判断不同，
    # 分级上它们不碰账号数据，所以走 SVIP 档公开返回
    ("助眠 资源列表(T0)", "/ncm/sati/resource/list", {"tag": "RCMD"}, lambda d: True, 200),
    ("助眠 更多(T0)",   "/ncm/sati/resource/list/more", {"id": 0}, lambda d: True, 200),
    ("助眠 收藏(写)",   "/ncm/sati/resource/sub", {"id": 0, "cancel": False, "confirm": 1}, lambda d: True, 401),
    ("助眠 我的收藏(需绑定)", "/ncm/sati/resource/sub/list", {},     lambda d: True, 401),
    ("助眠 场景(T0)",   "/ncm/sati/timescene/resources/get", {},    lambda d: True, 200),
    ("话题 热榜(T0)",   "/ncm/hot/topic", {"limit": 20, "offset": 0}, lambda d: True, 200),
    ("服务 上游版本(T0)", "/ncm/inner/version", {},                 lambda d: "data" in d, 200),
    ("服务 创作者认证(T0)", "/ncm/creator/authinfo/get", {},        lambda d: True, 200),
    ("服务 权益门槛(T0)", "/ncm/threshold/detail/get", {},          lambda d: True, 200),
    ("服务 评论摘要位(T0)", "/ncm/starpick/comments/summary", {},   lambda d: True, 200),
    ("服务 行政区划(T0)", "/ncm/lbs/city/code", {"bizCode": ""},    lambda d: True, 200),
    # 上游降级：不给风控下发的 evid/sign/token 时上游分别回 404 / 500（页面如实提示，
    # 不伪造参数）。所以这里接受 200 与 502 两种结果，上游修好后会自然变回 200。
    ("服务 验证二维码(T0·上游不稳)", "/ncm/verify/getQr", {"evid": "", "sign": "", "token": "", "type": 1, "vid": ""}, lambda d: True, (200, 502)),
    ("服务 扫码状态(T0·上游不稳)", "/ncm/verify/qrcodestatus", {"qr": ""}, lambda d: True, (200, 502)),
    ("搜索 本地匹配(T0)", "/ncm/search/match", {"md5": ""},          lambda d: True, 200),
    ("搜索 多重匹配(T0)", "/ncm/search/multimatch", {"md5": ""},     lambda d: True, 200),
    # 云贝补充（pages/member.js）
    ("云贝 裸接口",     "/ncm/yunbei", {},                          lambda d: True, 401),
    ("云贝 按额度完成(写)", "/ncm/yunbei/task/finish/v1", {"yunbeiAmount": 0, "confirm": 1}, lambda d: True, 401),
    # 数字专辑（付费）：/digitalAlbum/* （pages/albums.js）
    ("数字专辑 已购(需绑定)", "/ncm/digitalAlbum/purchased", {"limit": 20, "offset": 0}, lambda d: True, 401),
    ("数字专辑 详情",   "/ncm/digitalAlbum/detail", {"id": 1},       lambda d: True, 401),
    ("数字专辑 销量",   "/ncm/digitalAlbum/sales", {"ids": "1"},     lambda d: True, 401),
    ("数字专辑 下单(写)", "/ncm/digitalAlbum/ordering", {"id": 1, "payment": 0, "quantity": 1, "confirm": 1}, lambda d: True, 401),
    # T3 专用入口（/ncm/<上游路径>，直连项目专用路由而不是泛化转发）：
    # 未登录一律 401「未登录」；写操作缺少 confirm=1 时（登录后）应 400。
    ("T3 登出网易云",   "/ncm/logout", {"confirm": 1},               lambda d: True, 401),
    ("T3 消息隐私设置", "/ncm/setting", {},                         lambda d: True, 401),
    ("T3 验证码v1",     "/ncm/captcha/sent/v1", {"phone": "13800000000", "confirm": 1}, lambda d: True, 401),
    ("T3 安全验证码",   "/ncm/captcha/safe/sent", {"phone": "13800000000", "confirm": 1}, lambda d: True, 401),
    ("T3 邮箱登录",     "/ncm/login", {"email": "a@b.c", "password": "x", "confirm": 1}, lambda d: True, 401),
    ("T3 换绑手机",     "/ncm/rebind", {"phone": "13800000000", "confirm": 1}, lambda d: True, 401),
    ("T3 绑定手机",     "/ncm/user/bindingcellphone", {"phone": "13800000000", "confirm": 1}, lambda d: True, 401),
    ("T3 替换手机",     "/ncm/user/replacephone", {"phone": "13800000000", "confirm": 1}, lambda d: True, 401),
    ("T3 匿名注册",     "/ncm/register/anonimous", {"confirm": 1},  lambda d: True, 401),
    ("T3 手机注册",     "/ncm/register/cellphone", {"phone": "13800000000", "password": "x", "confirm": 1}, lambda d: True, 401),
    # 云盘上传与最后三个入口
    ("云盘 旧版上传(需绑定)", "/ncm/cloud", {"songName": "smoke", "confirm": 1},
     lambda d: True, 401, "POST", {"file": "SUQzBAAAAAA=", "filename": "a.mp3", "contentType": "audio/mpeg"}),
    ("云盘 上传令牌(需绑定)", "/ncm/cloud/upload/token", {"md5": "0" * 32, "fileSize": 1024, "filename": "a.mp3"}, lambda d: True, 401),
    ("云盘 上传完成(需绑定)", "/ncm/cloud/upload/complete", {"songId": 1, "resourceId": 1, "md5": "0" * 32, "filename": "a.mp3", "confirm": 1}, lambda d: True, 401),
    ("云盘 导入(需绑定)", "/ncm/cloud/import", {"md5": "0" * 32, "fileSize": 1024, "id": -2, "confirm": 1}, lambda d: True, 401),
    ("资源 点赞(写)",   "/ncm/resource/like", {"type": 1, "id": 10929613, "t": 1, "confirm": 1}, lambda d: True, 401),
    ("歌曲 向量(需绑定)", "/ncm/playmode/song/vector", {"ids": "347230"}, lambda d: True, 401),
    # /song/url/v1/302 返回的是**裸音频流**（body 以 ID3 开头），不是 JSON：
    # 经 JSON 网关必然解码失败（502），正确用法是当媒体地址直接播（前端用站点根代理）。
    ("音源 302媒体流(T0·非JSON)", "/ncm/song/url/v1/302", {"id": 347230, "level": "exhigh"}, lambda d: True, (200, 502)),
]

PHASES = {1: PHASE1, 2: PHASE1 + PHASE2, 3: PHASE1 + PHASE2 + PHASE3,
          4: PHASE1 + PHASE2 + PHASE3 + PHASE4,
          5: PHASE1 + PHASE2 + PHASE3 + PHASE4 + PHASE5}


def probe(base: str, path: str, params: dict, timeout: float = 25.0,
          method: str = "GET", body: dict | None = None):
    # 必须 URL 编码：keywords 常含中文，urllib 不接受非 ASCII 的 URL
    qs = urllib.parse.urlencode(params)
    url = f"{base}{path}" + (f"?{qs}" if qs else "")
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.code, {}
    except Exception as e:  # noqa: BLE001
        return 0, {"_err": type(e).__name__, "_msg": str(e)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:3011")
    ap.add_argument("--phase", type=int, default=1)
    # 服务端自带 300 次/分钟/IP 的限流：默认节流到约 4 req/s，避免自测把自己打成 429
    ap.add_argument("--delay", type=float, default=0.25, help="每个用例之间的间隔（秒）")
    args = ap.parse_args()

    cases = PHASES.get(args.phase)
    if not cases:
        print(f"阶段 {args.phase} 尚未登记冒烟用例")
        return 2

    ok = fail = 0
    print(f"网关契约冒烟 · 阶段 {args.phase} · {args.base}\n")
    for idx, case in enumerate(cases):
        name, path, params, check = case[:4]
        expect = case[4] if len(case) > 4 else 200
        method = case[5] if len(case) > 5 else "GET"
        body = case[6] if len(case) > 6 else None
        if idx and args.delay > 0:
            time.sleep(args.delay)
        status, data = probe(args.base, path, params, method=method, body=body)
        if status == 429:            # 撞上服务端限流：等一个窗口再试一次，不把限流当失败
            time.sleep(5.0)
            status, data = probe(args.base, path, params, method=method, body=body)
        expect_set = expect if isinstance(expect, (tuple, set, list)) else (expect,)
        good = status in expect_set and isinstance(data, dict) and check(data)
        if good:
            ok += 1
            extra = f" HTTP {status}"
            if isinstance(data.get("code"), int):
                extra += f" code={data['code']}"
            print(f"  ✓ {name:<22} {path}{extra}")
        else:
            fail += 1
            hint = (data.get("error") or data.get("msg") or data.get("message")
                    or data.get("code") or data.get("_msg"))
            print(f"  ✗ {name:<22} {path}  HTTP {status}（期望 {expect}）  {str(hint)[:60]}")
    print(f"\n通过 {ok} / {ok + fail}")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
