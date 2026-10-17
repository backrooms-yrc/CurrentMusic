# 第三方客户端接入：网易云登录态同步

面向 CurrentMusicX 等第三方客户端。目标：**用户在本站登录 CurrentMusic 账号后，
客户端自动沿用该账号已绑定的网易云登录态**，不需要用户再登录一次网易云。

## 核心原则

> **服务端不向第三方客户端下发网易云 cookie（MUSIC_U 等）。**

网易云登录态保存在服务端（按 CurrentMusic 用户维度）。客户端拿 CurrentMusic 的
Bearer token 调用 `/cm/ncm/*` 的 T1/T2 接口，服务端会自动注入该用户的绑定 cookie。
这样既能「同步登录态」，又不会让 cookie 落到客户端、被日志/抓包泄露。

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
