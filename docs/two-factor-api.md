# 登录两步验证（TOTP / 2FA）

用户在 CurrentMusic「设置 → 两步验证」开启或关闭。兼容 Google Authenticator、Microsoft Authenticator、Authy 等采用标准 TOTP 的验证器。使用 RFC 6238 HMAC-SHA1、6 位、30 秒周期，接受前后各一个时间步；已使用的时间步不可重放，请保持验证器设备时间准确。

## 登录接入

`POST /cm/auth/login`、`POST /cm/auth/login/email` 及内部登录入口，在第一重身份验证成功后：

- 未开启：沿用 `{token, user}`。
- 已开启：返回 `{requires2FA: true, challengeToken, expiresIn: 300}`，此时没有会话令牌或用户资料。

收到挑战后展示验证码输入框，调用 `POST /cm/auth/2fa/login`，JSON 为 `{challengeToken, code}`。`code` 可以是验证器 6 位码或一枚未使用的恢复码；成功返回 `{token, user}`，此时才能保存会话、完成跳转或发起 OAuth 授权。失败可在有效期内重试，过期需重新完成第一步。新挑战替换该账号旧挑战；挑战仅用于登录，不能用作 Bearer。旧客户端不能把缺少 token 的挑战响应当成登录成功，需要适配本协议；本次未修改或发布 X 原生客户端。

## 设置接口

以下接口使用当前会话 `Authorization: Bearer <token>`：

| 方法与路径（前缀 /cm） | 请求 / 返回 |
| --- | --- |
| GET /auth/2fa/status | `{enabled, recoveryCodesRemaining}`，不返回密钥或恢复码 |
| POST /auth/2fa/setup | `{password}` 校验当前密码；返回 `{secret, uri, expiresIn:600}`。仅当前会话可完成绑定；再次请求替换待绑定密钥 |
| POST /auth/2fa/enable | `{code}` 验证新验证器的 6 位码，成功才开启；返回 `{enabled:true, recoveryCodes:[...]}` |
| POST /auth/2fa/disable | `{password, code}` 当前密码 + 验证器码或恢复码；返回 `{enabled:false}` |

二维码由浏览器本地生成；也可手动输入 Base32 密钥。待绑定记录 10 分钟有效，不影响原有登录行为。开启和关闭都会撤销其他设备会话及其通行证授权，保留当前设备。恢复码共 10 枚、每枚 64 位随机熵、仅首次开启成功时返回，数据库仅保存其 SHA-256；恢复码使用后立即作废。剩余数量可在设置中查看；需要更换密钥或重新生成恢复码时，在安全设备上关闭后重新绑定。

失败校验按账号持久化限流（5 分钟内最多 5 次错误），跨挑战、跨设备、服务重启均不会清零；HTTP 429 表示暂时锁定。验证码和恢复码以数据库写事务原子校验与消费，防止并发复用。身份未通过时不会签发会话。HTTP 400 表示验证码不正确、已使用或挑战/绑定过期。

邮箱找回密码仍保留 2FA，且作废待登录挑战与待绑定操作，不能通过重置密码绕过验证器。如果同时丢失验证器和全部恢复码，则无法自助恢复，应联系站长核实身份。密钥保存在私有数据库，需要与生产用户数据一样保护数据库及备份，不得导出或公开。登录后 `/auth/me` 的 `twoFactorEnabled` 仅用于显示本人状态。

标准参考：[RFC 6238](https://www.rfc-editor.org/rfc/rfc6238)、[Google Authenticator Key URI Format](https://github.com/google/google-authenticator/wiki/Key-Uri-Format)。

## 登录密保问题（与验证器 2FA 互斥）

用户可在「设置 → 账号与隐私 → 账号与安全 → 登录密保问题」设置一个自定义问题和答案，或在新用户引导最后一页选择密保。验证器 2FA 和密保问题只能开启其中一种；切换前需要验证身份并关闭已开启的方式，不能直接覆盖。

| 方法与路径（前缀 /cm） | 行为 |
| --- | --- |
| GET /auth/security-question | Bearer；返回 `{enabled, question, twoFactorEnabled}`，不返回答案、盐或答案哈希 |
| POST /auth/security-question | Bearer；`{password, question, answer}`，验证当前密码后开启；问题 4~100 字，答案规范化后 2~128 字，不允许控制字符 |
| DELETE /auth/security-question | Bearer；`{password, answer}`，验证当前密码和原答案后关闭 |
| POST /auth/security-question/login | 无需 Bearer；`{challengeToken, answer}` 完成密保挑战，返回 `{token,user}` |

开启后，密码登录、邮箱验证码登录、内部登录的第一步会返回 `{requires2FA:false, requiresSecurityQuestion:true, verificationMethod:"security_question", securityQuestion, challengeToken, expiresIn:300}`。客户端须展示 `securityQuestion`，通过密保登录端点校验答案后再保存会话；没有会话令牌的挑战响应不能当作登录成功。问题仅向本人或已通过第一步身份验证的登录挑战返回，不能通过公开用户名查询。

验证器挑战仍然使用 `requires2FA:true` 和 `/auth/2fa/login`；两个验证端点不能交换使用。`GET /auth/2fa/status` 增加 `securityQuestionEnabled`、`securityQuestion`、`verificationMethod`，原 `enabled` 仍只表示验证器 TOTP 是否开启。`GET /auth/me` 增加 `securityQuestionEnabled` 和 `loginVerificationMethod`。

答案先做 Unicode NFKC 规范化、去除首尾空格并忽略英文大小写，再用独立随机盐和 PBKDF2-HMAC-SHA256（120000 次）存储。问题按文本显示；答案不会回显、进入日志或浏览器存储。两次输入答案在设置页面需一致。建议使用别人难以猜测的答案，避免公开信息。

挑战 5 分钟有效、单次使用；失败按账号持久化限流（5 次/5 分钟），不能通过重新发起登录绕过。开启或关闭会作废已有挑战并撤销其他设备会话及其通行证授权。并发启用 TOTP 与密保也会检查互斥；冲突返回 409。密码重置保留密保，并作废已有登录挑战。忘记答案无法通过仅重置密码绕过，请联系站长核实身份后处理。
