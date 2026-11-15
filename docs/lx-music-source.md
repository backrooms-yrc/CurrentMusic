# 落雪音乐自定义音源

CurrentMusic Engine 可以包装成[落雪音乐（LX Music）](https://github.com/lyswhut/lx-music-desktop)的自定义音源：在 LX Music 的「设置 → 自定义源」中通过 URL 导入一条直链，「网易音乐」源的播放地址与歌词即由 Engine 以你的 CurrentMusic 账号解析。

```
https://music.20110208.xyz/cm/lx/source.js?token=<音源专用令牌>
```

直链由 CurrentMusic 网页端「设置 → 服务器 → 落雪音乐音源」生成并复制。脚本导入后生效的能力：

- **musicUrl**（wy 源）：声明 `128k / 320k / flac / flac24bit / hires / atmos / master` 七档。官方 lx-music-desktop/mobile 的 wy 白名单只有前四档，多余值由客户端过滤；**CurrentMusicX 最新 CI**（`LxSource.kt` 的 `lxQualities`）支持全部七档，界面显示为 标准 / 极高 / 无损 / 24bit / Hi-Res / 高清臻音 / 超清母带。档位映射：

  | 客户端音质 | Engine level | 说明 |
  | --- | --- | --- |
  | `128k` | `standard` | 标准 |
  | `320k` | `exhigh` | 极高 |
  | `flac` | `lossless` | 无损 |
  | `flac24bit` | `hires` | 24bit（Engine 无独立 24bit 档） |
  | `hires` | `hires` | Hi-Res |
  | `atmos` | `jyeffect` | 高清臻音 |
  | `master` | `jymaster` | 超清母带 |

  客户端若传 `192k`/`ape`/`wav` 亦按 `exhigh`/`lossless`/`lossless` 处理。**注意 `qualitys` 里绝不能出现 `jymaster` 等 Engine 内部档位名**，客户端不认识会漏掉对应档位。
- **取流音质**：`/cm/ncm/song/url` 默认携带**服务端 SVIP Cookie**（见 `cm_ncm.call`），因此**所有注册用户**（无需自行绑定网易云会员）都能取得该账号可用的最高档；实测母带档返回 192kHz/24bit、约 4.5Mbps。请求档位在歌曲没有对应资源时由 Engine 自动降档，不会直接失败；CurrentMusicX 的「自动最高」按声明档位从高到低尝试，并在单档解析失败时自动换下一档。
- **lyric**（wy 源）：歌词走 Engine 归一化接口，主歌词、翻译与罗马音按毫秒时间轴转换成 LRC。官方客户端的 `wy` 动作白名单只开放 `musicUrl`，因此不在 `inited` 中声明；支持该协议的衍生客户端可直接调用；
- 其余音源（kw/kg/tx/mg）与动作会明确返回不支持，不会误解析。

脚本遵循官方自定义源运行时协议：`request` 事件的 handler **返回 Promise**（官方沙箱直接对返回值 `.then()`，不传 callback），同时兼容老式 callback 调用；沙箱已预解析的 JSON 响应（`resp.body` 为对象）与字符串响应都能处理；整体包在 IIFE 中，重复载入不会因顶层重复声明而失败。

## 专用令牌

直链中的令牌优先使用**音源专用令牌**（`clx_` 前缀，每账号一个）：

- 只能用于 `/lx/source.js` 与 `/ncm/song/url` 两个端点——不能登录、不能读取资料、不能调用任何其它接口；
- 独立于登录会话：退出登录、修改密码、「下线其他设备」都不会使它失效；
- 服务端只保存其 sha256 哈希，明文只在生成/轮换时返回一次；网页端会把直链缓存在本机（localStorage）以便随时复制，换设备后可轮换取得新直链；
- 退出登录之外的失效方式只有两种：**轮换**（旧直链立即作废，返回新直链）与**撤销**（音源功能停用）。

直链也兼容登录会话令牌（早期行为）：它随会话生命周期失效，可在「登录设备」中下线。推荐所有用户改用专用令牌。

## 音源脚本

`GET /cm/lx/source.js` 按查询参数中的个人令牌返回定制的音源脚本。

| 查询参数 | 说明 |
| --- | --- |
| `token` | 音源专用令牌（`clx_`）或登录会话令牌，必填 |

- 成功返回 HTTP 200，`Content-Type: text/javascript`，头部携带 LX 客户端解析的 `@name/@description/@version/@author` 注释，主体监听 `globalThis.lx` 的 `request` 事件并回连 `/cm/ncm/song/url`（带 `Authorization: Bearer`）与公开的 `/cm/ncm/lyric`。
- 缺少 `token` 返回 HTTP 401。
- **令牌无效或已失效**（轮换/撤销后的旧直链、已退出的登录会话）：客户端只显示 HTTP 状态码、不显示响应体，裸 401 会让用户看到「下载音源失败（HTTP 401）」而无从判断。因此这里返回 HTTP 200 的**失效提示脚本**：源列表中直接显示「直链已失效，请到 CurrentMusic 设置页重新复制」的说明，且不声明任何可用音源（不会产生错误播放）。提示脚本不含任何令牌。
- 响应声明 `Cache-Control: no-store`：脚本内容因人而异且内嵌令牌，不允许任何中间缓存。
- 端点按认证入口限速（30 次/分钟/IP）。令牌为高熵随机值，路径本身不泄露额外信息。

## 公用（内部测试）令牌

需要把音源临时分享给多位测试者时，管理员可签发**公用令牌**（`clx_sh_` 前缀）：

- 与个人令牌同权限、同样的端点范围（仅 `/lx/source.js` 与 `/ncm/song/url`），不能登录、不能读资料；
- 可同时存在多条，可分别设置到期时间（`expiresAt` 或 `days`），也可随时单独撤销/删除；
- 一条失效不影响其它令牌，也不影响签发者的个人专用令牌；
- 取链身份记为签发者账号，服务端 SVIP Cookie 同样生效。

| 端点 | 说明 |
| --- | --- |
| `GET /cm/lx/shared` | 列出全部公用令牌状态（不含明文） |
| `POST /cm/lx/shared` | 签发：`{label, expiresAt}` 或 `{label, days}`（0/省略 = 不过期），一次性返回 `{token, sourceUrl}` |
| `POST /cm/lx/shared/{id}/revoke` | 立即撤销，使用该令牌的直链随即失效 |
| `POST /cm/lx/shared/{id}/delete` | 删除记录（撤销后的清理） |

以上均需**管理员**登录会话；公用令牌自身不能调用管理接口。

## 管理 API

以下端点均需登录会话 Bearer（专用令牌不能管理自身，避免持有直链者永久固化访问权）。

| 端点 | 说明 |
| --- | --- |
| `GET /cm/lx/token` | 令牌状态 `{enabled, createdAt, lastSeen}`；不返回明文 |
| `POST /cm/lx/token` | 生成专用令牌，一次性返回 `{token, sourceUrl}`；已有令牌时幂等返回 `{created:false}` 与状态 |
| `POST /cm/lx/token/rotate` | 轮换（`{confirm:1}`）：旧直链立即失效，一次性返回新 `{token, sourceUrl}` |
| `DELETE /cm/lx/token` | 撤销（`{confirm:1}`）：全部落雪客户端的直链立即失效 |

## 安全边界

- 直链与导入后的脚本内容都等同于「仅限取链」的凭证，仍**请勿分享给他人**；它只能以你自己的账号取链，不能读取你的网易云 Cookie 或其他凭据。
- 怀疑泄露时轮换令牌即可；彻底停用走撤销。
- 取链请求仍受[播放音源策略](playback-sources.md)约束：按调用方 IP 隔离缓存、匹配音频须通过完整时长与音频头校验，不会因第三方客户端调用而放宽。
