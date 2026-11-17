# 自研音源导入与取链

此页保留旧版接口说明。新的客户端接入请使用[外接音乐服务协议](music-service-api.md)。

支持自研音源导入的流声音乐 X 版本中，登录 CurrentMusic，打开「设置 → 音源与网络 → 从服务器导入」，选择「流声引擎」后点「导入并使用」。配置来自当前账号所在的 HTTPS 服务器。该音源用于网易云曲库取链，歌词来源在 App 中另选。

## 音源目录

`GET /cm/audio-sources` 使用 CurrentMusic 登录会话的 `Authorization: Bearer` 请求头。

```json
{
  "version": 1,
  "sources": [
    {"id": "currentmusic-engine", "name": "流声引擎", "platforms": ["netease"]}
  ]
}
```

`version` 是目录和取链协议版本。v1 的音源 ID 使用小写 ASCII 字母、数字和连字符，以字母开头，最长 64 字符。每条配置只包含标识、名称和支持的平台。客户端校验版本和平台，用户确认后按账号与服务器保存配置。旧服务器返回 `404` 时提示暂不支持音源导入。

## 音源取链

从目录取得音源 ID 后，客户端使用同一服务器和登录会话请求 `GET /cm/audio-sources/{sourceId}/resolve`。请求禁止重定向。媒体 URL 用于播放，客户端只向 CurrentMusic API 发送登录会话。

| 查询参数 | 说明 |
| --- | --- |
| `id` | 必填，网易云歌曲 ID |
| `level` | 默认 `auto`，接受现有网易云取链音质值 |
| `refresh` | 传 `1` 时请求换线或刷新播放地址 |
| `supportsDolby` | 支持杜比的设备在自动音质下传 `1` |

```sh
curl -H "Authorization: Bearer ${CURRENTMUSIC_TOKEN}" \
  'https://music.20110208.xyz/cm/audio-sources/currentmusic-engine/resolve?id=12345&level=auto&supportsDolby=1'
```

成功响应沿用 [网易云播放取链](playback-sources.md) 的 `url`、实际 `level`、`type` 和音频信息。两个接口均返回 `Cache-Control: no-store`。缺少有效登录会话时返回 `401`；无效歌曲 ID 返回 `400`；未注册的音源返回 `404`；频率超限返回 `429`；解析不到经过校验的音频时返回 `502`，错误码为 `playback_match_failed`。
