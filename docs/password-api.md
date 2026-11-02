# 密码找回与修改（邮箱验证码）

> CurrentMusic / CurrentStation 账号的密码找回与修改接口。
> 在线接口目录：`GET /cm/station/api-catalog`；在线文档：[通行证接入专题](https://music.20110208.xyz/api-docs/reference/guide-passport-api/)，完整目录见 [API 文档站](https://music.20110208.xyz/api-docs/)。
> 本文是仓库内镜像，便于离线查阅与 code review。

账号密码有两条路径：

| 场景 | 入口 | 需要的凭证 | 结果 |
|---|---|---|---|
| 忘记密码（未登录/已登录均可） | `POST /cm/auth/password/reset` | 邮箱 + 验证码 | 设置新密码，**全部设备下线** |
| 已登录修改密码 | `PUT /cm/profile/password` | 原密码 **或** 邮箱验证码 | 设置新密码；邮箱验证码方式只下线其他设备 |

邮箱验证码找回与修改要求账号**已绑定邮箱**；已登录且知道原密码的账号仍可使用原密码修改，
无需事先绑定邮箱。邮箱验证码的存储键是 `reset:<email>`，与注册码
（裸邮箱）、登录码（`login:<email>`）、换绑邮箱码（`bind:<email>`）命名空间隔离——
别处收到的验证码不能拿来重置密码。

## 1. 找回密码（未登录）

### 1.1 发送验证码

```http
POST /cm/auth/password/code
Content-Type: application/json

{"email": "user@example.com"}
```

成功：

```json
{"ok": true, "ttl": 300}
```

错误：

| HTTP | 文案 | 说明 |
|---|---|---|
| 400 | 邮箱格式不正确 | 邮箱为空或格式不对 |
| 404 | 该邮箱未注册，请先注册或在设置中绑定邮箱 | 该邮箱不属于任何账号 |
| 403 | 账号已被禁用，请联系管理员 | 账号被管理员禁用 |
| 429 | 发送太频繁，请 N 秒后再试 | 同一邮箱 60 秒冷却 |
| 429 | 当前网络请求验证码过于频繁，请稍后再试 | 同一 IP 每小时最多 10 条 |
| 500 | 邮件服务未配置，请联系管理员 | 服务端未配置 SMTP |
| 502 | 邮件发送失败，请稍后重试 | SMTP 发送异常 |

验证码为 6 位数字，5 分钟有效，在同一邮箱上重发会覆盖旧码。

### 1.2 提交新密码

```http
POST /cm/auth/password/reset
Content-Type: application/json

{"email": "user@example.com", "code": "123456", "newPassword": "new-secret"}
```

成功：

```json
{"ok": true, "username": "alice", "nickname": "Alice"}
```

服务端会：

1. 校验验证码（错误次数上限 5 次，超过即作废；用后即焚）；
2. 用与注册相同的 pbkdf2-sha256 + 随机盐写入新密码；
3. **吊销该账号全部会话**（所有 App / 网页下线）并撤销该账号发出的全部通行证授权；
4. 返回用户名/昵称，客户端可据此回填登录框。

错误：

| HTTP | 文案 | 说明 |
|---|---|---|
| 400 | 请填写邮箱与验证码 | 缺字段 |
| 400 | 新密码长度需 6~64 位 | 密码长度不符合策略 |
| 400 | 验证码已过期，请重新获取 | 超过 5 分钟或从未发送 |
| 400 | 验证码错误 | 码不匹配，剩余尝试次数递减 |
| 400 | 错误次数过多，验证码已作废，请重新获取 | 同一验证码错满 5 次 |
| 404 | 该邮箱未注册 | 邮箱不属于任何账号 |
| 403 | 账号已被禁用，请联系管理员 | 账号被禁用 |

> **安全取舍**：发码接口会明确返回「该邮箱未注册」。这与现有
> `POST /cm/auth/login/email/code` 的行为一致（该接口同样要求邮箱已注册），
> 便于用户定位问题；如果你部署的站点不希望暴露账号是否存在，可把 404 改成
> 统一的成功响应（不发信），代价是用户无法判断邮箱是否填错。

### 1.3 客户端示意

```js
// 1) 发码
await api.sendPasswordResetCode(email);

// 2) 重置
const r = await api.resetPassword(email, code, newPassword);
// r.username / r.nickname 可用于回填登录框；
// 此时本地 token 已失效，应清理登录态并回到登录页。
```

## 2. 已登录修改密码

### 2.1 方式 A：原密码

```http
PUT /cm/profile/password
Authorization: Bearer <token>
Content-Type: application/json

{"oldPassword": "old-secret", "newPassword": "new-secret"}
```

成功后当前会话保持在线。该方式不会下线其他设备（与历史行为一致）。

### 2.2 方式 B：邮箱验证码

适用于「还登录着，但原密码忘了」或多账号切换场景。

**发送到当前账号绑定的邮箱**（不需要客户端传邮箱）：

```http
POST /cm/profile/password/code
Authorization: Bearer <token>
Content-Type: application/json

{}
```

成功：

```json
{"ok": true, "ttl": 300, "email": "u***@example.com"}
```

未绑定邮箱返回 `400 当前账号未绑定邮箱，请先在设置中绑定邮箱`。

**提交验证码 + 新密码**：

```http
PUT /cm/profile/password
Authorization: Bearer <token>
Content-Type: application/json

{"emailCode": "123456", "newPassword": "new-secret"}
```

成功：

```json
{"ok": true, "revoked": 2}
```

服务端会设置新密码，并**下线其他设备**（保留当前会话；`revoked` 为被下线的设备数）。
如果请求同时带了 `oldPassword` 与 `emailCode`，以 `emailCode` 为准。

错误：

| HTTP | 文案 | 说明 |
|---|---|---|
| 400 | 新密码长度需 6~64 位 | 密码长度不符合策略 |
| 400 | 请填写原密码或邮箱验证码 | 两种凭证都没传 |
| 400 | 当前账号未绑定邮箱，无法使用邮箱验证码修改密码 | 账号没有邮箱 |
| 400 | 原密码错误 | 方式 A 校验失败 |
| 400 | 验证码已过期 / 验证码错误 / 错误次数过多 | 同 1.2 |
| 429 | 发送太频繁 / 当前网络请求验证码过于频繁 | 同 1.1 |

## 3. 限流与有效期

| 项目 | 值 |
|---|---|
| 验证码 | 6 位数字，5 分钟有效 |
| 单邮箱重发冷却 | 60 秒（DB 持久，服务重启不清零） |
| 单 IP 发码 | 10 条/小时（进程内；登录码、绑定码、找回码共用计数） |
| 单验证码错误次数 | 5 次，超过即作废 |
| 认证入口限速 | 30 次/分钟/IP（`/auth/password/*`、`/profile/password*` 均计入） |
| 密码长度 | 6~64 位 |

## 4. 客户端入口

- **未登录**：登录页密码框下方的「忘记密码？」→ 输入邮箱、验证码、新密码。
- **已登录**：我的 → 账号管理 → 「修改密码」→ 切换「原密码 / 邮箱验证码」。
- **CurrentStation 控制台**与 **CurrentDeveloper 开发者平台**的登录卡也提供「忘记密码？」。
- 未绑定邮箱的账号：设置 → CurrentStation 通行证 → 绑定邮箱（或 `/cm/profile/email/code`）。

## 5. 部署要求

- 服务端必须配置 `CM_SMTP_USER` / `CM_SMTP_PASS`（QQ 邮箱 SMTP SSL），否则发码接口返回 500。
- 反向代理需允许 `POST /cm/auth/password/code`、`POST /cm/auth/password/reset`；
  这两个是公开接口，不需要 Bearer。
- 重置成功会撤销全部通行证授权，第三方应用需重新走 OAuth 授权；这是密码变更后的预期行为。
