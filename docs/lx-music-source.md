# 落雪音乐自定义音源

CurrentMusic Engine 可以包装成[落雪音乐（LX Music）](https://github.com/lyswhut/lx-music-desktop)的自定义音源：在 LX Music 的「设置 → 自定义源」中通过 URL 导入一条直链，「网易音乐」源的播放地址与歌词即由 Engine 以你的 CurrentMusic 账号解析。

```
https://music.20110208.xyz/cm/lx/source.js?token=<你的登录令牌>
```

直链由 CurrentMusic 网页端「设置 → 服务器 → 落雪音乐音源」生成并复制。脚本导入后生效的能力：

- **musicUrl**（wy 源）：`128k / 320k / flac / flac24bit` 四档，分别映射 Engine 的 `standard / exhigh / lossless / jymaster` 档位，享受注册用户级取链与[灰色曲目匹配](playback-sources.md)；
- **lyric**（wy 源）：歌词走 Engine 归一化接口，主歌词、翻译与罗马音按毫秒时间轴转换成 LRC；
- 其余音源（kw/kg/tx/mg）与动作会明确返回不支持，不会误解析。

## API

`GET /cm/lx/source.js` 按查询参数中的个人令牌返回定制的音源脚本。

| 查询参数 | 说明 |
| --- | --- |
| `token` | CurrentMusic 个人登录令牌（与 SSE 查询参数同口径），必填 |

- 成功返回 HTTP 200，`Content-Type: text/javascript`，头部携带 LX 客户端解析的 `@name/@description/@version/@author` 注释，主体监听 `globalThis.lx` 的 `request` 事件并回连 `/cm/ncm/song/url`（带 `Authorization: Bearer`）与公开的 `/cm/ncm/lyric`。
- 缺少或失效令牌（退出登录、修改密码、下线设备）返回 HTTP 401；此时重新登录 CurrentMusic 并更新 LX 中的音源直链即可。
- 响应声明 `Cache-Control: no-store`：脚本内容因人而异且内嵌令牌，不允许任何中间缓存。
- 端点按认证入口限速（30 次/分钟/IP）。令牌为高熵随机值，路径本身不泄露额外信息。

## 安全边界

- 直链与导入后的脚本内容都等同于登录凭证，**请勿分享给他人**；它只能以你自己的账号取链，不能读取你的网易云 Cookie 或其他凭据。
- 怀疑泄露时，在「设置 → 登录设备」中下线对应设备（或修改密码），旧直链立即失效。
- 取链请求仍受[播放音源策略](playback-sources.md)约束：按调用方 IP 隔离缓存、匹配音频须通过完整时长与音频头校验，不会因第三方客户端调用而放宽。
