# 歌曲分享 API

供网页、App 与第三方客户端（CurrentMusicX 等）复用同一套分享链接与分享文案。
分享图由客户端实时生成，本接口只提供生成所需的元数据。

## 接口

`GET /cm/share/song/{ncm_id}` — **公开，无需登录**

```json
{
  "id": 3340114785,
  "name": "Reply",
  "artists": "kz / かぐや(cv.夏吉ゆうこ) / 超かぐや姫！",
  "album": "超かぐや姫！",
  "pic": "https://p3.music.126.net/…/109951172602675059.jpg",
  "duration": 269343,
  "url": "https://music.20110208.xyz/app/#/song/3340114785",
  "image": "https://music.20110208.xyz/cm/share/song/3340114785/image",
  "text": "🎵 Reply - kz / かぐや(cv.夏吉ゆうこ) / 超かぐや姫！\n专辑：超かぐや姫！\n\n在 CurrentMusic 收听：https://music.20110208.xyz/app/#/song/3340114785"
}
```

| 字段 | 说明 |
|---|---|
| `id` | 网易云歌曲 id |
| `name` / `artists` / `album` | 歌名 / 歌手（` / ` 分隔）/ 专辑 |
| `pic` | 封面（https） |
| `duration` | 时长（毫秒） |
| `url` | 分享链接：`<站点>/app/#/song/<id>`，按请求的 `Host` 与 `X-Forwarded-Proto` 生成 |
| `image` | 服务端渲染好的分享图直链（1080×1440 JPEG） |
| `text` | 可直接复制的分享文案（歌名 / 歌手 / 专辑 / 链接） |

- 歌曲信息缓存 1 天；`url` 与 `text` 每次按当前请求的站点生成，不在缓存里写死 Host。
- 错误：id 非法 400、歌曲不存在 404、上游异常 502。

## 分享落地页

`…/app/#/song/<id>` 是公开页面：展示封面、歌名、歌手、专辑，提供「播放这首歌」与「分享」。
未登录可以浏览，播放时会引导登录（音源仅限注册用户，见 v1.28.33）。

## 分享图

### 服务端接口（推荐第三方客户端使用）

`GET /cm/share/song/{id}/image` — **公开，无需登录**，直接返回 `image/jpeg`：
1080×1440 卡片，背景取色自封面，含封面、歌名/歌手/专辑、分享链接与二维码。
按「分享链接 + 版式版本」缓存 7 天，Host 变化不会串图；响应带 `Cache-Control: public, max-age=3600`。

依赖 `Pillow`、`segno`、Noto Sans CJK 字体；部署环境缺少任意一项时该接口返回 503
（其余接口不受影响）。第三方客户端也可以继续用上面的元数据自行绘制。

### 客户端本地生成

网页/App 仍会用 canvas 实时绘制同一版式（离线可用）：

1. 封面加载（网易云 CDN 带 CORS）；从封面 40×40 采样提取主色，作为背景渐变与柔光；
2. 版式：品牌、封面、歌名/歌手/专辑、分隔线、左侧链接文案、右侧二维码；
3. 二维码内容就是 `url`（EC 级别 M，含 4 模块静区）；生成后用 `jsQR` 实测可解码；
4. 导出 JPEG；网页端 `<a download>` 下载，App 端通过原生桥 `NativeApi.saveImage`
   写入 `Pictures/CurrentMusic`（Android 10+）或应用图片目录。

封面加载失败或画布被污染时，客户端会自动降级为品牌紫渐变占位封面，仍能出图。

## 第三方客户端接入

登录 CurrentMusic 账号后（Bearer token 仅用于受保护接口），分享本身不需要登录：

```text
1. GET /cm/share/song/{id}
2. 用返回的 url / text 打开系统分享或复制
3. 分享图：直接使用返回的 image 直链（服务端已渲染并缓存）；
   如需离线/自定义版式，再用 pic 作封面、url 作二维码内容自行绘制
```

没有账号的用户也可以直接扫码或打开 `url` 收听（播放需要登录，浏览不需要）。
