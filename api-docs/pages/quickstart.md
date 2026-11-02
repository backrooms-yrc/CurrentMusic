# 快速开始

以下示例使用主站。你可以把 API 基址统一替换为同一镜像域名的 `/cm`；不要把 HTTP 错误页当成 JSON。

## 1. 检查服务

```bash
curl 'https://music.20110208.xyz/cm/health'
```

响应示例（时间戳仅作格式示例）：

```json
{"ok": true, "now": 1793450000}
```

## 2. 搜索歌曲

```bash
curl --get 'https://music.20110208.xyz/cm/ncm/search' \
  --data-urlencode 'keywords=晴天' \
  --data-urlencode 'limit=10' \
  --data-urlencode 'offset=0'
```

歌曲搜索响应是项目归一化的 `{songs:[...]}`。使用每首歌曲的 `ncm_id` 继续请求详情、歌词与播放地址。网易云其它搜索类型和 `/cloudsearch` 的响应可能采用不同上游结构，不能把所有搜索接口视为相同模型。

## 3. 登录 CurrentMusic

```bash
curl --request POST 'https://music.20110208.xyz/cm/auth/login' \
  --header 'Content-Type: application/json' \
  --data '{"username":"YOUR_USERNAME","password":"YOUR_PASSWORD","device":"我的客户端","platform":"web"}'
```

成功返回会话 `token` 及账户 `user`。以下示例的 `YOUR_CURRENTMUSIC_TOKEN` 需要替换为该 token；不要把令牌放入 URL、日志或公开分享内容。

```bash
curl 'https://music.20110208.xyz/cm/auth/me' \
  --header 'Authorization: Bearer YOUR_CURRENTMUSIC_TOKEN'
```

没有账号时先通过手机或邮箱发码注册。验证码必须由对应账号持有人获取，具体字段与冷却规则见账号章节；各用途验证码不通用。

## 4. 解析播放地址

```bash
curl 'https://music.20110208.xyz/cm/ncm/song/url?id=186016&level=auto' \
  --header 'Authorization: Bearer YOUR_CURRENTMUSIC_TOKEN'
```

解析音源需要注册用户登录。`auto` 由后端选择可用档位；返回的 `url` 有有效期，不能永久保存。媒体实际播放通常直接从音频 CDN 拉取，接口测速不等于音频下载测速。部分歌曲或音质不可用时，按响应错误处理，不要无限重试。

## 5. 获取归一化歌词

```bash
curl 'https://music.20110208.xyz/cm/ncm/lyric?id=186016'
```

时间单位为毫秒。官方逐字歌词、外部逐字补全和估算轴的区别详见[歌词协议](guide-lyrics-api.md)。

## 浏览器 fetch

```javascript
const base = location.origin + '/cm'; // 同一入口部署有 /cm 时使用
async function request(path, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(base + path, {
      credentials: 'omit', signal: controller.signal,
      headers: token ? {Authorization: 'Bearer ' + token} : {}
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status);
    return data;
  } finally { clearTimeout(timer); }
}
```

客户端应区分超时、HTTP 错误、上游业务错误和 JSON 解析失败，并提供手动重试。播放地址冷解析与 AI SSE 不能共用一个过短的超时策略。
