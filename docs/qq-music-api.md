# QQ 音乐接入

流声引擎通过独立部署的 [QQ Music API v3.3.6](https://github.com/yakult-green-tea/qq-music-api/releases/tag/v3.3.6) 访问 QQ 音乐。入口为 `/cm/qqmusic`。公开搜索、曲库、歌词和评论允许匿名读取。可使用个人会话增强搜索、歌单详情及部分推荐。音频和 MV 取址、个人数据和账号写入需要 CurrentMusic Bearer 和用户自己的 QQ 会话。

## 扫码与会话

1. 通过 `GET /cm/qqmusic/login/channels` 查询部署支持的登录通道。
2. 使用 CurrentMusic Bearer 请求 `POST /cm/qqmusic/login/qr/key`，JSON 为 `{"channel":"qqmusic"}`。通道也可选 `qq` 或 `wechat`，默认 `qq`。保存响应的 `data.unikey`。
3. 请求 `POST /cm/qqmusic/login/qr/create`，JSON 为 `{"key":"YOUR_QR_KEY"}`，按 `data.qrimg` 的 data URL 类型显示二维码。
4. 以相同请求体调用 `POST /cm/qqmusic/login/qr/check`。`801` 等待扫码，`802` 等待确认，`803` 成功，`800` 已过期或失败。扫码成功时保存 `data.session`，同源浏览器也可使用响应设置的 HttpOnly Cookie `qqmusic_session`。关闭扫码页面时可用 `POST /cm/qqmusic/login/qr/cancel` 释放当前二维码。
5. 后续用 `GET /cm/qqmusic/login/status` 查询，`POST /cm/qqmusic/login/refresh` 续期，`POST /cm/qqmusic/logout` 撤销。退出时发送 `{"confirm":1}`。

扫码标识只能由发起它的站内账号使用，且只能通过 JSON 请求体提交。每个上游实例一次处理一个扫码流程，忙时返回 `409`。QQ 会话应通过 `X-QQ-Session` 或同源 Cookie 传递，同时携带发起扫码的 CurrentMusic 账号 Bearer。流声引擎只保存会话摘要用于校验账号归属。所有 QQ 响应均为 `Cache-Control: no-store`。

```bash
curl 'https://music.20110208.xyz/cm/qqmusic/search?keywords=%E5%91%A8%E6%9D%B0%E4%BC%A6&type=song&limit=5'
curl 'https://music.20110208.xyz/cm/qqmusic/song/url?id=YOUR_QQ_SONG_MID&level=auto' \
  -H "Authorization: Bearer ${CURRENTMUSIC_TOKEN}" \
  -H "X-QQ-Session: ${QQ_SESSION}"
```

## 网易云形状兼容入口

QQ ID 为字符串。歌曲包含 `id`、`qq_mid` 和 `provider: "qqmusic"`，以及网易云接口常用的 `name`、`artists`、`artist_ids`、`album`、`pic`、`duration` 等字段。`duration` 单位为毫秒。QQ ID 用于本页接口，站内现有网易云歌单、听歌记录、分享等接口仍使用网易云 ID。

| 网易云路径 | QQ 路径（省略 `/cm/qqmusic`） | 参数与响应 |
| --- | --- | --- |
| `/ncm/search` | `/search` | `keywords` 1–60 字符，`type` 支持 `song,artist,album,playlist`，可逗号分隔。默认全部类型。支持 `offset` 0–1000 和 `limit` 1–50。返回分类数组、`totals` 和 `hasMore`。 |
| `/ncm/song/detail` | `/song/detail` | `ids` 逗号分隔，最多 100 个 QQ song MID。返回 `{songs}`，保留输入顺序，略过明确不存在的条目。 |
| `/ncm/lyric` | `/lyric` | `id` 为 song MID。返回 `lines[].t/txt/trans/roma` 和可选 `w/words/wSynth`。`source` 为 `qqmusic:lrc` 或 `none`，估算逐字标记 `wSynth`。 |
| `/ncm/album` | `/album` | `id` 为 album MID，返回专辑资料、`size` 和 `songs`。 |
| `/ncm/artist`、`/ncm/artist/albums` | `/artist`、`/artist/albums` | `id` 为 singer MID，支持 `offset`、`limit`。歌手页返回资料、分页曲目和首屏专辑。 |
| `/ncm/playlist` | `/playlist` | `id` 为 QQ 歌单 ID，返回 `id/name/cover/creator/description/trackCount/songs`，最多附带 100 首。 |
| `/ncm/song/url` | `/song/url` | `id` 为 song MID。默认 `level=auto`；支持 `standard`（128K）、`exhigh`（320K）、`lossless`（FLAC）。返回 `url/level/requestedLevel/quality/source`，未知音频规格留空或为 0。 |

自动档位使用上游 `best`。指定正数 `maxBr` 时，只在上限允许的 MP3 档位内取址，单位为 bit/s。请求每次按当前用户取址，兼容参数 `refresh` 无需强制指定。CDN 指定或切换、网易云专有音效参数不适用于 QQ。完整取址缺失或只返回试听时为 `422` 与 `qq_playback_unavailable`。不支持的档位返回 `422` 与 `qq_quality_unsupported`。音质和可用性由 QQ 上游及账号权益决定。

## QQ 原生能力对照

`/cm/qqmusic/native` 下沿用 QQ Music API 路径、参数和业务响应。`{参数?}` 表示可选路径段，可省略。详情见 [完整接口清单](qqmusic.md) 和 [上游参数与响应](https://github.com/yakult-green-tea/qq-music-api/blob/v3.3.6/docs/README.md#api-接口一览)。任何原生账号写入都用 POST，并在 JSON 里带 `confirm: 1`。原生读接口 `POST /song/batch` 无需确认。原生媒体取址也要求个人会话，可通过 `preview=1` 明确请求试听。

| 网易云能力 | QQ 对应原生路径（省略 `/cm/qqmusic/native`） |
| --- | --- |
| 搜索、热搜、联想、直达 | `/search`、`/search/hot`、`/search/suggest`、`/search/match`，及登录后的 `/search/users` |
| 歌曲详情、其他版本、相似曲目、收藏量 | `/getSongInfo`、`/song/batch`、`/song/versions`、`/song/similar`、`/song/related-playlists`、`/song/fav-count`、`/song/labels` |
| 歌词与取址 | `/getLyric`、`/getMusicPlay`、`/song/replacement` |
| 专辑、歌手、歌单浏览 | `/getAlbumInfo`、`/singer/*`、`/getSingerAlbum`、`/getSingerHotsong`、`/getSongListDetail` |
| 榜单、新歌、新专辑、分类歌单 | `/recommend/toplists`、`/recommend/toplist`、`/recommend/new-songs`、`/recommend/new-albums`、`/recommend/categories*`、`/recommend/category-playlists*` |
| 推荐、私人漫游、电台、每日推荐 | `/recommend/*`、`/radio/*`、`/user/guess-you-like*`、`/user/personal-fm`、`/user/daily-songs*` |
| 视频资源 | `/mv/list`、`/mv/detail`、`/mv/url`、`/song/mvs` |
| 热门评论、最新评论、总数、回复 | `/comment/hot`、`/comment/new`、`/comment/count`、`/comment/list` |
| 个人资料、权益、排行榜和偏好 | `/user/detail`、`/user/vip`、`/user/music-gene`、`/user/listening-rank`、`/user/recommendation-preferences*`、`/user/blacklist*` |
| 自建与收藏歌单、歌曲红心、收藏专辑 | `/user/playlist*`、`/user/liked-songs`、`/user/song/like`、`/user/albums`、`/user/album/subscribe`、`/user/subscription-status` |
| 云盘 | `/user/cloud` 读取 |

QQ Music API v3.3.6 缺少按歌词搜索、评论写入、云盘上传、播放上报等网易云能力。网易云专有的播客、账号变更和动态等路由也不在 QQ 登记表中。

## 状态码

| HTTP | 说明 |
| --- | --- |
| `400` | 参数错误、凭据提交方式错误或缺少写操作确认 |
| `401` | 缺少 CurrentMusic 或 QQ 会话、会话无效 |
| `403` | 权限或跨源 Cookie 写入限制 |
| `404`、`405` | 路径未登记、资源未找到或方法不符 |
| `409`、`429` | 扫码繁忙、上游或引擎限流 |
| `422` | 不支持的档位、未取得完整链接或上游业务拒绝 |
| `502`、`503`、`504` | 上游异常、服务未启用或超时 |

原生旧路由可能用 HTTP `200` 携带上游业务错误码，调用方应同时检查 JSON。匿名搜索也可能被 QQ 上游拒绝并返回 `502`，与搜索成功但没有结果的空数组分别处理。
