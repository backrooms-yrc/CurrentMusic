# 私人漫游 API

供 CurrentMusic 网页/App 与第三方客户端使用的私人漫游接口，对齐 CurrentMusicX
v1.1.18 的模式/场景协议及网易云 `/personal/fm/mode` 上游行为。

所有接口需要 **CurrentMusic Bearer token**；推荐歌曲与垃圾桶操作还要求已绑定网易云账号
（使用用户自己的 `ncmbind` cookie，不使用服务器共享账号）。

## 模式目录

`GET /cm/roaming/catalog`

```json
{
  "source": "builtin",
  "modes": [
    {"code": "DEFAULT", "title": "默认模式", "subtitle": "沿着目前喜好继续聆听"},
    {"code": "FAMILIAR", "title": "熟悉模式", "subtitle": "喜欢过的歌曲与相似推荐"},
    {"code": "EXPLORE", "title": "探索模式", "subtitle": "偏好曲风与潜力好歌"},
    {"code": "PUZZLE_MODE_RCMD", "title": "拼图模式", "subtitle": "边听歌边拼歌曲封面"}
  ],
  "scenes": [
    {"code": "NIGHT_EMO", "title": "伤感"},
    {"code": "EXERCISE", "title": "运动"},
    {"code": "SLEEP_HELP", "title": "助眠"},
    {"code": "RELAX", "title": "放松"},
    {"code": "FOCUS", "title": "专注"},
    {"code": "COMMUTE", "title": "出行"}
  ]
}
```

内置目录与 CurrentMusicX 的 fallback 一致；上游暂未提供可读取的目录接口时以此为准。
`PUZZLE_MODE_RCMD` 只负责返回推荐歌曲，拼图动画由客户端绘制。

## 取推荐歌曲

`POST /cm/roaming/songs`

```json
{
  "mode": "DEFAULT",
  "subMode": "",
  "limit": 20,
  "excludeIds": [347230, 186016]
}
```

- `mode`：`DEFAULT` / `FAMILIAR` / `EXPLORE` / `PUZZLE_MODE_RCMD` / `SCENE_RCMD`
- `subMode`：仅 `SCENE_RCMD` 必填，取上面的 `scenes[].code`
- `limit`：1~30，默认 20
- `excludeIds`：可选，服务端过滤已播放歌曲（最多 200 个）

响应：

```json
{
  "mode": "DEFAULT",
  "subMode": "",
  "count": 3,
  "songs": [
    {
      "ncm_id": 405599119,
      "name": "7 Years",
      "artists": "Lukas Graham",
      "album": "Lukas Graham",
      "pic": "https://p3.music.126.net/…jpg",
      "duration": 240000,
      "fee": 1,
      "pop": 100,
      "mv": 0
    }
  ]
}
```

`excludeIds` 是服务端过滤，不代表上游一定返回足量新歌；客户端可继续“换一批”，
若返回为空则提示稍后再试或切换模式。每次请求都是账号态个性化推荐，不做服务端缓存。

## 不喜欢（垃圾桶）

`POST /cm/roaming/trash`

```json
{"id": 405599119}
```

把歌曲移入网易云私人漫游垃圾桶（上游 `/fm_trash`），成功返回
`{"ok": true, "id": 405599119}`。该操作需要绑定网易云账号。

## 和原始 NCM 代理的关系

原有的通用代理仍然可用：

```text
GET/POST /cm/ncm/personal/fm/mode?mode=DEFAULT&submode=...
GET      /cm/ncm/personal_fm
POST     /cm/ncm/fm_trash?id=...&confirm=1
```

新接口额外做了：模式白名单、场景参数校验、歌曲字段归一化、`excludeIds` 过滤、
垃圾桶免二次确认包装，以及统一的 Bearer/绑定错误提示。第三方客户端优先使用
`/cm/roaming/*`，不必依赖 API-enhanced 的原始响应结构。

## 与 CurrentMusicX 的关系

CurrentMusicX v1.1.18 的私人漫游使用本机网易云账号直连 `/api/v1/radio/get`，
不经过 CurrentMusic 后端；这里提供的是同一套模式/场景语义、供 CurrentMusic 网页/App
和其它第三方客户端复用的服务端版本。
