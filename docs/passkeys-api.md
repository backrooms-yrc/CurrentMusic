# 通行密钥（WebAuthn）

网页登录页提供“通行密钥登录”，设置 → 账号与安全 → 通行密钥可绑定、查看和撤销。
需要支持 WebAuthn 的 HTTPS 浏览器；当前 Android WebView 桥不提供该能力，请在浏览器打开。

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
| POST | /auth/passkeys/register/options | Bearer；{password,factor} → {challengeToken,publicKey} |
| POST | /auth/passkeys/register/verify | Bearer；{challengeToken,credential,name} → {ok:true} |
| POST | /auth/passkeys/login/options | {} → {challengeToken,publicKey}；无需用户名 |
| POST | /auth/passkeys/login/verify | {challengeToken,credential,device,platform} → {token,user} |
| POST | /auth/passkeys/delete | Bearer；{id,password,factor} → {ok:true} |

POST 请求必须具有四个官方 HTTPS 入口之一的真实 Origin；绑定挑战额外绑定用户和当前会话。
挑战 5 分钟有效、一次消费；验签失败也消费挑战，需重新获取。过期、错误签名、错误来源、
缺少用户验证、停用账号、已撤销凭据均拒绝登录。响应禁止缓存，认证入口沿用 IP 限流。

部署先安装 `python3 -m pip install -r deploy/requirements-auth.txt`（可使用隔离环境），
再更新并重启 API 服务。数据库新表按需安全创建，不更改已有密码、密保或 2FA 设置。

验证：`PYTHONPATH=backend tools/run-tests.sh -p test_passkeys.py`，所有数据库测试使用临时数据库。
另使用 Chromium 虚拟 CTAP2 验证器测试真实创建、签名登录和撤销；生产浏览器的实际生物识别由用户设备完成。

## 自托管域名

通过环境变量 `CM_PASSKEY_ORIGINS=https://music.example.com,https://other.example.com:8443` 显式配置允许的 HTTPS origin。设置后替换官方默认清单；空清单、HTTP、通配符、含账号/密码或路径/查询的值会使后端启动失败，避免意外放宽 Origin 校验。反向代理的 Host/Origin 需要与实际 HTTPS 入口一致。不同域名的 RP ID 与凭据保持独立。
