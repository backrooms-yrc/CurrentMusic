# 第三方客户端接入：网易云登录态同步

面向 CurrentMusicX 等第三方客户端。目标：**用户在本站登录 CurrentMusic 账号后，
客户端自动沿用该账号已绑定的网易云登录态**，不需要用户再登录一次网易云。

## 核心原则

> **服务端不向第三方客户端下发网易云 cookie（MUSIC_U 等）。**

网易云登录态保存在服务端（按 CurrentMusic 用户维度）。客户端拿 CurrentMusic 的
Bearer token 调用 `/cm/ncm/*` 的 T1/T2 接口，服务端会自动注入该用户的绑定 cookie。
已有服务端绑定可直接沿用，不需要下载 Cookie。对于在 X 本机直接登录产生的新凭据，使用下文专用导入接口写入服务端；服务端仍不会将 Cookie 下发给其他客户端。

## 1. 登录 CurrentMusic 账号

用与网页端相同的账号接口（`POST /cm/auth/login`）或邮箱验证码登录
（`POST /cm/auth/login/email`），拿到：

```json
{ "token": "…", "user": { "id": 150, "username": "…", "nickname": "…" } }
```

之后所有请求带：

```
Authorization: Bearer <token>
```

## 2. 一次调用判断网易云登录态

`GET /cm/ncmbind/session`

```json
{
  "bound": true,
  "valid": true,
  "stale": false,
  "profile": { "uid": 4994500926, "nickname": "Faded-Flower", "avatar": "https://…" },
  "lastSync": 1792220000,
  "lastSyncCount": 36,
  "note": "登录态有效"
}
```

| 字段 | 含义 |
|---|---|
| `bound` | 该 CurrentMusic 账号是否已绑定网易云 |
| `valid` | 绑定 cookie 当前是否仍然有效（`true` 有效 / `false` 已失效 / `null` 上游查询失败，稍后再试） |
| `stale` | 服务端标记的失效状态（与 `valid` 同步更新） |
| `profile` | 网易云昵称 / 头像 / uid（`bound=false` 时为 `null`） |
| `note` | 可直接展示给用户的说明 |

**客户端行为建议**：

- `bound && valid` → 直接进入音乐功能，**不要**再弹网易云登录；
- `bound && !valid` → 提示「网易云登录已失效」，给「重新绑定」按钮，或先尝试 `POST /cm/ncmbind/refresh`；
- `!bound` → 引导绑定（见下节）。

> 只要用户曾在网页端 / App 绑定过网易云，这里就会返回 `bound=true` —— 这就是
> 「自动同步登录态」的全部实现方式，不需要额外传 cookie。

## 3. 未绑定时：二维码绑定（推荐）

| 步骤 | 请求 | 返回 |
|---|---|---|
| 1 | `POST /cm/ncmbind/qr/key` | `{ "key": "…" }` |
| 2 | `GET /cm/ncmbind/qr/img?key=<key>` | `{ "qrimg": "data:image/png;base64,…" }` |
| 3 | 每 2~3 秒轮询 `GET /cm/ncmbind/qr/check?key=<key>` | `{ "code": 801/802/803/800 }` |

状态码（网易云约定）：

| code | 含义 | 客户端动作 |
|---|---|---|
| 801 | 等待扫码 | 继续轮询 |
| 802 | 已扫码，等待确认 | 提示「请在手机上确认」 |
| 803 | 登录成功并已绑定 | 停止轮询，读取返回的 `profile`，重新调 `/ncmbind/session` |
| 800 | 二维码过期 | 停止轮询，重新取 key |

二维码 key 与服务端会话绑定：生成后只能由同一用户轮询。

## 4. 未绑定时：手机验证码绑定

| 步骤 | 请求 | 说明 |
|---|---|---|
| 1 | `POST /cm/ncmbind/phone/code` `{ "phone": "138…", "ctcode": "86" }` | 60 秒冷却 |
| 2 | `POST /cm/ncmbind/phone/login` `{ "phone": "138…", "captcha": "1234", "ctcode": "86" }` | 成功即绑定 |

## 本机登录同步至 CurrentMusic（X 侧）

X 扫码/手机登录可能直接连接网易云并将凭据保存在设备本地。这与服务端绑定是两份状态。
新版接入流程在本机登录成功后自动调用以下接口；旧版本 X 不会因后端上线而自动具备此能力。
已有本机有效登录在升级、启动或登录 CurrentMusic 后会静默同步，无需再次扫码或手动确认。切换账号或服务器后同步至当前账号与当前所选 HTTPS 服务器；绑定页保留「同步绑定」入口。

### `POST /cm/ncmbind/import`

使用 **HTTPS**，并携带发起绑定时同一 CurrentMusic 账号的 `Authorization: Bearer <token>`。
只把凭据发往该账号当时选定的服务器；禁止传入 URL 查询参数、输出到日志或发送给无关服务。

```json
{
  "cookie": "MUSIC_U=<device-session>; __csrf=<csrf>",
  "expectedNcmUid": 12345
}
```

- `cookie`：必填字符串，最多 16384 个 ASCII 字符，只接受 `MUSIC_U`、`__csrf`、`NMTID`、`MUSIC_A`，其中 `MUSIC_U` 必填；不接受重复键、控制字符或其他 Cookie。
- `expectedNcmUid`：必填正整数，为本机刚登录的网易云 UID，用于与服务端验证结果比对。
- 服务端向网易云验证 Cookie，昵称、头像和 UID 均使用验证结果，不信任客户端伪造资料。
- 只更新 Bearer 对应的 CurrentMusic 用户；成功响应不含 Cookie，使用 `Cache-Control: no-store`。
- 同一网易云账号重复同步保留歌单导入进度；换绑其他网易云账号时清除旧绑定的红心歌单定位和同步统计，并使相关缓存失效。已导入歌单快照保留。

成功响应结构：

```json
{"ok":true,"bound":true,"profile":{"uid":12345,"nickname":"示例昵称","avatar":"https://example.com/avatar.jpg"}}
```

| HTTP 状态 | 含义 |
| --- | --- |
| 400 | 参数、Cookie 格式或期望 UID 无效 |
| 401 | CurrentMusic 未登录，或网易云登录凭据失效；应区分错误文案，网易云失效不表示本站会话失效 |
| 409 | Cookie 对应的网易云账号与 `expectedNcmUid` 不一致；保留原服务端绑定 |
| 429 | 请求限流 |
| 502 | 网易云验证失败或超时；保留原服务端绑定 |

客户端在账号、服务器或本机网易云登录态变化时停止旧同步，不重试旧账号的凭据。
同步失败保留本机登录，后台在 5 秒、30 秒、120 秒间隔后有限重试，切换账号/服务器/本机登录态会取消旧任务。一次运行中，同一会话与网易云登录态同步成功后不重复上传。绑定页也提供重试入口；成功后同一账号的 Web/CurrentMusic App
通过 `GET /cm/ncmbind` 或 `/cm/ncmbind/session` 即可读到绑定。
这里同步的是绑定登录态，**歌单快照仍通过 `POST /cm/ncmbind/sync` 单独导入**。
X 的「退出本机」仍只清理本机凭据，服务端绑定保留；需要全端解绑时使用本站的解绑入口。

## 5. 绑定后：正常调用音乐接口

同一条 Bearer token，调用 T1/T2 接口即可，服务端自动带上网易云 cookie：

```
GET /cm/ncm/user/playlist?uid=<ncmUid>&limit=200
GET /cm/ncm/recommend/resource
GET /cm/ncm/like?ids=…
POST /cm/ncm/playmode/intelligence/list
```

未绑定 / 登录态失效时，这些接口会返回 401 与明确文案
（`请先绑定网易云账号后再使用该功能`），据此引导用户去绑定或刷新。

### 歌曲红心

`POST /cm/ncmbind/like/{ncmId}` 使用当前绑定账号，接受歌曲元数据和布尔值 `like`。成功时返回 `liked` 和网易云红心计数 `count`。当上游红心接口返回带歌单 ID 的 500 时，服务端会核对该歌单是绑定账号自己的「我喜欢的音乐」，再通过歌单接口添加或移除歌曲。写入成功后更新红心状态和已导入的歌单快照。

网易云登录过期返回 `401` 并提示重新绑定。限流和明确的业务拒绝保留对应的错误状态。上游不可用或备用写入失败时，客户端应保留原有红心状态并显示接口返回的错误。

## 6. 维护接口

| 接口 | 用途 |
|---|---|
| `POST /cm/ncmbind/refresh` | cookie 续期，成功后可继续使用，无需重新扫码 |
| `GET /cm/ncmbind` | 轻量绑定信息（profile / stale / 上次同步），不查上游 |
| `POST /cm/ncmbind/sync` | 把网易云歌单同步为本站歌单快照 |
| `DELETE /cm/ncmbind` | 解绑（已导入歌单保留为本地快照） |

## 7. 常见问题

**Q：能不能给一个直接返回 cookie 的接口？**
不能。cookie 等于网易云账号的完整登录凭据；下发到客户端后无法审计、无法限权、
泄露即失控。服务端代理 T1/T2 已经能覆盖播放、歌单、红心等全部账号级功能。

**Q：X 登录了 CurrentMusic 账号，为什么 `bound=false`？**
说明该 CurrentMusic 账号本身没有绑定过网易云（或曾在别处解绑）。让用户走一次第 3/4
节的绑定流程即可，绑定是**账号级**的，之后网页端、App、X 都会共享同一份登录态。

**Q：`valid=null` 怎么办？**
上游暂时查询失败（超时/限流），不代表登录态失效。稍后重试，或直接调用音乐接口验证。

## 8. 参考实现（伪代码）

```kotlin
suspend fun ensureNcmSession(token: String): NcmSession {
    val s = api.get("/cm/ncmbind/session", bearer = token)
    return when {
        s.bound && s.valid == true -> s                      // 直接可用
        s.bound && s.valid == false -> {                     // 已绑定但失效
            runCatching { api.post("/cm/ncmbind/refresh", bearer = token) }
            api.get("/cm/ncmbind/session", bearer = token)
        }
        else -> showBindSheetAndWait()                       // 未绑定 → 二维码/手机绑定
    }
}
```
