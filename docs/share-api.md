# 分享 API

供网页、App 与第三方客户端（CurrentMusicX 等）复用同一套分享链接、分享文案与分享图。
覆盖**歌曲、歌单、歌手、专辑**四种实体；分享图可由客户端 canvas 实时生成，也可直接取服务端渲染图。

## 接口一览

| 实体 | 元数据 | 分享图 | 落地页 |
|---|---|---|---|
| 歌曲 | `GET /cm/share/song/{ncm_id}` | `GET /cm/share/song/{id}/image` | `#/song/{id}` |
| 网易云歌单 | `GET /cm/share/playlist/{ncm_pl_id}` | `GET /cm/share/playlist/{id}/image` | `#/ncmpl/{id}` |
| 站内歌单 | `GET /cm/share/local-playlist/{playlist_id}` | `GET /cm/share/local-playlist/{id}/image` | `#/pl/{id}` |
| 歌手 | `GET /cm/share/artist/{artist_id}` | `GET /cm/share/artist/{id}/image` | `#/artist/{id}` |
| 专辑 | `GET /cm/share/album/{album_id}` | `GET /cm/share/album/{id}/image` | `#/album/{id}` |

所有接口均为**公开，无需登录**；`url` 与 `text` 按当前请求的 `Host` 与
`X-Forwarded-Proto` 生成。服务端实体信息缓存 1 天（歌单/歌手/专辑）/ 歌曲 1 天。

## 歌曲

`GET /cm/share/song/{ncm_id}`

```json
{
  "id": 3340114785,
  "type": "song",
  "name": "Reply",
  "artists": "kz / かぐや(cv.夏吉ゆうこ) / 超かぐや姫！",
  "album": "超かぐや姫！",
  "sub": "kz / かぐや(cv.夏吉ゆうこ) / 超かぐや姫！",
  "sub2": "超かぐや姫！",
  "pic": "https://p3.music.126.net/…/109951172602675059.jpg",
  "duration": 269343,
  "url": "https://music.example.com/app/#/song/3340114785",
  "image": "https://music.example.com/cm/share/song/3340114785/image",
  "images": {
    "square": "https://music.example.com/cm/share/song/3340114785/image?style=square",
    "immersive": "https://music.example.com/cm/share/song/3340114785/image?style=immersive"
  },
  "text": "🎵 Reply - kz / かぐや(cv.夏吉ゆうこ) / 超かぐや姫！\n专辑：超かぐや姫！\n\n在 CurrentMusic 收听：https://music.example.com/app/#/song/3340114785"
}
```

| 字段 | 说明 |
|---|---|
| `id` | 网易云歌曲 id |
| `type` | 实体类型：`song` / `playlist` / `local-playlist` / `artist` / `album` |
| `name` / `artists` / `album` | 歌名 / 歌手（` / ` 分隔）/ 专辑 |
| `sub` / `sub2` | 通用副标题 / 补充信息；歌曲分别为歌手 / 专辑 |
| `pic` | 封面（https） |
| `duration` | 时长（毫秒），仅歌曲 |
| `url` | 分享链接，见上表落地页 |
| `image` | 兼容现有调用方的默认方块封面分享图直链 |
| `images` | `square` 与 `immersive` 对应的服务端分享图直链（均为 1080×1440 JPEG） |
| `text` | 可直接复制的分享文案 |

## 歌单 / 歌手 / 专辑

```text
GET /cm/share/playlist/{ncm_pl_id}
GET /cm/share/local-playlist/{playlist_id}
GET /cm/share/artist/{artist_id}
GET /cm/share/album/{album_id}
```

通用字段：

- `type`：`playlist` / `local-playlist` / `artist` / `album`
- `name` / `pic` / `sub` / `sub2` / `url` / `text` / `image` / `images`
- 歌单额外返回 `creator`（网易云）或 `owner`/`description`（站内）与 `trackCount`；
- 歌手额外返回 `alias`、`total`（作品数）、`albumTotal`；
- 专辑额外返回 `artist`、`size`、`publishTime`、`company`。

示例（歌手）：

```json
{
  "id": 6452,
  "type": "artist",
  "name": "周杰伦",
  "alias": "Jay Chou / 周董",
  "total": 581,
  "albumTotal": 45,
  "sub": "Jay Chou / 周董",
  "sub2": "581 首作品 · 45 张专辑",
  "url": "https://music.example.com/app/#/artist/6452",
  "image": "https://music.example.com/cm/share/artist/6452/image",
  "images": {
    "square": "https://music.example.com/cm/share/artist/6452/image?style=square",
    "immersive": "https://music.example.com/cm/share/artist/6452/image?style=immersive"
  },
  "text": "🎤 歌手：周杰伦\nJay Chou / 周董\n581 首作品 · 45 张专辑\n\n在 CurrentMusic 查看歌手：https://music.example.com/app/#/artist/6452"
}
```

错误：id 非法 400、实体不存在 404、上游异常 502。

## 分享落地页

- 歌曲：`…/app/#/song/<id>`
- 网易云歌单：`…/app/#/ncmpl/<id>`
- 站内歌单：`…/app/#/pl/<id>`
- 歌手：`…/app/#/artist/<id>`
- 专辑：`…/app/#/album/<id>`

均为公开页面，可浏览；播放/收藏等需要登录的操作会引导登录（音源仅限注册用户）。

## 分享图

### 服务端接口（推荐第三方客户端使用）

`GET /cm/share/{type}/{id}/image` 为公开接口，直接返回 1080×1440 `image/jpeg`。可用查询参数 `style` 选择封面版式。

| `style` | 版式 |
| --- | --- |
| `square` | 方块封面，搭配封面取色渐变背景。省略 `style` 时使用此版式 |
| `immersive` | 沉浸式封面，将封面等比铺满并居中裁切，在品牌和文字区域叠加渐暗遮罩 |

`GET /cm/share/song/3340114785/image?style=immersive` 返回该歌曲的沉浸式分享图。其他 `style` 值（含空值）返回 `400`。

两种版式都包含名称、分享链接和二维码。封面无法读取时会绘制渐变占位。服务端按分享链接和版式版本分别缓存 7 天，响应带 `Cache-Control: public, max-age=3600`。反向代理如果缓存此接口，应将公开协议、域名和完整请求 URI（含 `style`）计入缓存键。

依赖 `Pillow`、`segno`、Noto Sans CJK 字体；部署环境缺少任意一项时该接口返回 503
（其余接口不受影响）。第三方客户端也可以继续用上面的元数据自行绘制。

### 客户端本地生成

网页和 App 使用 canvas 在本地绘制，生成前可选方块封面或沉浸式封面。封面处理和排版以所选版式为准。

1. 封面加载（网易云 CDN 带 CORS）；从封面 40×40 采样提取主色，作为背景渐变与柔光；
2. 版式：品牌、封面、名称/副标题/补充信息、分隔线、左侧链接文案、右侧二维码；
3. 二维码内容就是 `url`（EC 级别 M，含 4 模块静区）；生成后用 `jsQR` 实测可解码；
4. 导出 JPEG；网页端 `<a download>` 下载，App 端通过原生桥 `NativeApi.saveImage`
   写入 `Pictures/CurrentMusic`（Android 10+）或应用图片目录。

封面加载失败或画布被污染时，客户端会自动降级为品牌渐变占位封面，仍能出图。

## 第三方客户端接入

登录 CurrentMusic 账号后（Bearer token 仅用于受保护接口），分享本身不需要登录：

```text
1. GET /cm/share/{type}/{id}
2. 用返回的 url / text 打开系统分享或复制
3. 按所选版式加载 images.square 或 images.immersive；旧客户端仍可读取默认 image。
   如需离线或自定义版式，可用 pic 作封面、url 作二维码内容自行绘制。
```

没有账号的用户也可以直接扫码或打开 `url` 浏览；播放需要登录。
