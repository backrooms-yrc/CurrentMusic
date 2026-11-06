# 通行密钥（WebAuthn）

网页登录页提供“通行密钥登录”，设置 → 账号与安全 → 通行密钥可绑定、查看和撤销。
网页入口需要支持 WebAuthn 的 HTTPS 浏览器。CurrentMusic 的 Android WebView 用户可在浏览器打开网页。
支持原生通行密钥的 CurrentMusicX 版本可通过 Android Credential Manager 登录，绑定和撤销仍在网页端完成。

登录使用可发现凭据和 `userVerification=required`，须通过设备指纹、人脸或 PIN 验证。
服务端验证 RP ID、Origin、挑战、用户句柄、公钥签名和签名计数，成功后直接签发本站会话，
**无需再进行 TOTP 二步验证或回答密保**。密码和邮箱验证码登录仍保留原有二次验证规则。

绑定/删除需 Bearer、当前密码，以及已启用的 TOTP 验证码或密保答案（`factor`）。
不支持用恢复码管理通行密钥；可先按现有恢复流程登录、恢复验证方式后再绑定。
私钥留在验证器/用户选择的同步密钥管理器；本站仅保存凭据 ID、公钥和使用信息。
同一账号最多 20 个密钥；四个官方域名 RP ID 独立，不能跨域复用，需分别绑定。
丢失密钥仍可用既有登录方式；撤销密钥阻止后续登录，不主动踢出已登录会话，可在设备管理中下线。

| 方法 | 路径（/cm 前缀） | 请求/响应 |
| --- | --- | --- |
| GET | /auth/passkeys | Bearer；返回 keys（id,name,rp,created,last_used） |
| POST | /auth/passkeys/register/options | Bearer；{password,factor} → {challengeToken,expiresIn,publicKey} |
| POST | /auth/passkeys/register/verify | Bearer；{challengeToken,credential,name} → {ok:true} |
| POST | /auth/passkeys/login/options | 网页传 `{}`，原生端传 `{"platform":"app"}`；返回 {challengeToken,expiresIn,publicKey} |
| POST | /auth/passkeys/login/verify | {challengeToken,credential,device,platform} → {token,user} |
| POST | /auth/passkeys/delete | Bearer；{id,password,factor} → {ok:true} |

获取挑战和提交凭据时，均须发送同一个获准的 `Origin`，可以是 HTTPS 网页来源或显式配置的 Android 签名来源。
后端将 Origin 和 RP ID 写入挑战，绑定挑战还关联账号和当前会话。HTTP `Origin` 用于查找来源配置及匹配挑战，
验签时还会检查 `clientDataJSON.origin` 是否与挑战来源完全一致。
挑战 5 分钟有效（`expiresIn: 300`）、一次消费；验签失败也消费挑战，需重新获取。过期、错误签名、错误来源、
缺少用户验证、停用账号、已撤销凭据均拒绝登录。响应禁止缓存，认证入口沿用 IP 限流。

部署先安装 `python3 -m pip install -r deploy/requirements-auth.txt`（可使用隔离环境），
再更新并重启 API 服务。首次使用通行密钥接口时会自动为已有挑战表补充 RP ID 列，进行中的网页挑战仍可在原域名完成。

验证：`PYTHONPATH=backend tools/run-tests.sh -p test_passkeys.py`，所有数据库测试使用临时数据库。
另使用 Chromium 虚拟 CTAP2 验证器测试真实创建、签名登录和撤销；生产浏览器的实际生物识别由用户设备完成。

## Android 原生登录

CurrentMusicX 正式包名为 `com.bileizhen.currentmusic`。内置主站及各 CDN 线路均向 `https://music.20110208.xyz/cm/` 请求认证，使用 RP ID `music.20110208.xyz` 下已有的可发现通行密钥。其他域名绑定的凭据需在目标 RP 下重新绑定。自定义线路使用自身的 HTTPS 认证地址和域名。

获取选项和提交凭据均为匿名请求。两个请求使用相同的内容类型和签名来源头部。

```http
Content-Type: application/json
Origin: android:apk-key-hash:_D5jB5uOaa6nq3NIKEbaCTnWzRLa8K__qpouk_v8zzU
```

1. `POST /cm/auth/passkeys/login/options`，请求体为 `{"platform":"app"}`。成功返回 `challengeToken`、`expiresIn` 和 `publicKey`。客户端检查 `publicKey.rpId` 为当前认证域名、`userVerification` 为 `required`，再将 `publicKey` 交给 Credential Manager。`allowCredentials` 为空数组，由系统选择可发现凭据。
2. `POST /cm/auth/passkeys/login/verify`，请求体带上 `challengeToken`、Credential Manager 返回的 `credential`、设备描述 `device` 和 `"platform":"app"`。`credential` 包含 `id`、`rawId`、`type`，其 `response` 包含 Base64URL 编码的 `clientDataJSON`、`authenticatorData`、`signature` 和 `userHandle`。成功响应为 `{token,user}`，此时可保存会话。来源缺失或未经授权时返回 `403` 和 `error`，挑战或凭据验证失败时返回 `400` 和 `error`。

参见 [Android Credential Manager 前置要求](https://developer.android.com/identity/credential-manager/prerequisites)和 [Android 通行密钥登录](https://developer.android.com/identity/passkeys/sign-in-with-passkeys)。

## 自托管域名与 Android 关联

通过环境变量 `CM_PASSKEY_ORIGINS=https://music.example.com,https://other.example.com:8443` 显式配置允许的 HTTPS Origin。设置后替换官方默认清单；空清单、HTTP、通配符、含账号/密码或路径/查询的值会使后端启动失败。不同域名的 RP ID 与凭据保持独立。

要开启原生登录，通过 `CM_PASSKEY_ANDROID_ORIGINS` 配置签名来源与 RP ID 的 JSON 映射。下例为官方主站使用的映射。

```json
{
  "android:apk-key-hash:_D5jB5uOaa6nq3NIKEbaCTnWzRLa8K__qpouk_v8zzU": "music.20110208.xyz"
}
```

- Origin 后缀为 APK 签名证书 DER 的 32 字节 SHA-256 摘要，经 Base64URL 编码并去掉填充。使用 `apksigner verify --print-certs` 核对实际分发 APK 的证书指纹。RP ID 必须精确匹配已允许的 HTTPS 域名，值为不含端口的 DNS 域名。未配置映射时 Android 来源全部拒绝。
- 在 RP 域名根路径 `/.well-known/assetlinks.json` 发布 Digital Asset Links。声明包含 `delegate_permission/common.get_login_creds`、包名及正式证书的 SHA-256 指纹。官方声明见 [assetlinks.json](https://music.20110208.xyz/.well-known/assetlinks.json)。该路径应通过可信 HTTPS 直接返回 `200 application/json`，无需登录或验证码。测试包和调试签名使用独立测试域名。
- 反向代理须原样转发 `Origin`，包括 `android:apk-key-hash:…`。自托管时将上述映射的值改为自己的 HTTPS 认证域名，并在该域名发布对应声明。更改映射后重启 API，旧挑战只有在其 Origin 和 RP ID 仍与配置一致时才能使用。
