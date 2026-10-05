# CurrentStation 通行证 · 接入文档

> Current 系产品的**统一登录平台**。在线文档页：`GET /cm/passport/docs`（与本文同源，随版本发布）。
> 本文件是仓库内的镜像，便于离线查阅与 code review。

- 协议：**OAuth 2.0 授权码 + PKCE**（RFC 6749 / 7636 / 7009 / 7662）
- Issuer：`https://music.20110208.xyz/cm`
- 端点前缀：`/cm/passport/*`；账号本体（注册/登录/会话/设备）仍在 `/cm/auth/*`，两者共用同一批账号
- 元信息（可编程读取）：`GET /cm/passport/meta`

## 1. 一次登录的完整流程

```
用户                你的应用                      CurrentStation 通行证
 │  点「用通行证登录」  │                                  │
 │────────────────────▶│ 302 /passport/authorize?…        │
 │◀───────────────────────────────────────────────────────│ 未登录先在本站登录
 │  看到「应用名 + 申请哪些权限」并点同意                    │
 │───────────────────────────────────────────────────────▶│ 生成一次性 code（60 秒）
 │                     │◀─ 302 redirect_uri?code=…&state=… ─┘
 │                     │ POST /passport/token（code + verifier）
 │                     │◀─ access_token / refresh_token ─────┘
 │                     │ GET /passport/userinfo（Bearer）
```

## 2. 快速开始

### 2.1 登记应用（管理员，一次性）

```bash
curl -X POST https://music.20110208.xyz/cm/passport/apps \
  -H "Authorization: Bearer <管理员会话令牌>" -H "Content-Type: application/json" \
  -d '{"name":"CurrentSpace",
       "redirects":["https://currentspace.20110208.xyz/auth/callback"],
       "scopes":"openid profile email offline_access",
       "homepage":"https://currentspace.20110208.xyz"}'
# 201 → { "clientId": "cs_app_…", "clientSecret": "cs_sk_…" }
```

`clientSecret` **只在创建时返回一次**。原生 App / 纯前端 SPA 请加 `"public": true`（不发密钥，强制 PKCE）。
管理员也可在 App 内操作：设置 → CurrentStation 通行证 → 应用登记。

### 2.2 把用户送到授权页（PKCE）

```js
const verifier  = base64url(crypto.getRandomValues(new Uint8Array(32)));
const challenge = base64url(new Uint8Array(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
sessionStorage.setItem('pkce', verifier);

location.href = 'https://music.20110208.xyz/cm/passport/authorize'
  + '?response_type=code'
  + '&client_id=' + CLIENT_ID
  + '&redirect_uri=' + encodeURIComponent(REDIRECT_URI)
  + '&scope=' + encodeURIComponent('openid profile email offline_access')
  + '&state=' + state
  + '&code_challenge=' + challenge + '&code_challenge_method=S256';
```

### 2.3 用 code 换令牌

```bash
curl -X POST https://music.20110208.xyz/cm/passport/token \
  -H "Content-Type: application/json" \
  -d '{"grant_type":"authorization_code","client_id":"cs_app_…","client_secret":"cs_sk_…",
       "code":"cs_code_…","redirect_uri":"https://…/auth/callback","code_verifier":"…"}'
# 200 → { access_token, token_type:"Bearer", expires_in:7200, refresh_token?, sub, scope }
```

### 2.4 取用户信息

```bash
curl https://music.20110208.xyz/cm/passport/userinfo -H "Authorization: Bearer cs_at_…"
# 200 → { sub, nickname, avatar, email:"m***@qq.com", scope, client_id }
```

## 3. 端点一览

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/passport/meta` | 公开 | 端点表、scope 目录、令牌有效期、已接入产品 |
| GET | `/passport/docs` | 公开 | 在线文档页（自包含 HTML） |
| POST | `/passport/apps` | 登录用户 | 自助登记应用（返回 clientId/clientSecret，密钥仅一次）；每账号上限 5 个 |
| GET | `/passport/apps` | 登录用户 | 我登记的应用（含在用授权数与配额）；管理员加 `?all=1` 看全部 |
| PUT | `/passport/apps/{client_id}` | 所有者 | 改名称/主页/回调/scope/公开↔机密/停用 |
| POST | `/passport/apps/{client_id}/secret` | 所有者 | 轮换 client_secret（仅返回一次）；`revokeGrants` 可同时撤销该应用已发出的授权 |
| DELETE | `/passport/apps/{client_id}` | 所有者 | 停用并撤销该应用全部授权 |
| GET | `/passport/authorize` | 用户会话 | 同意页数据（应用名、权限、当前用户） |
| POST | `/passport/authorize` | 用户会话 | 批准/拒绝 → 返回回调地址（带 code 或 error） |
| POST | `/passport/token` | 客户端 | `authorization_code` / `refresh_token` / `client_credentials` |
| GET | `/passport/userinfo` | Bearer | 按 scope 返回用户信息 |
| POST | `/passport/introspect` | 客户端 | 校验令牌（RFC 7662） |
| POST | `/passport/revoke` | 客户端或用户 | 撤销令牌（RFC 7009，幂等 200） |
| GET | `/passport/grants` | 用户会话 | 我授权过的应用 |
| DELETE | `/passport/grants/{授权id}` | 用户会话 | 解除授权（令牌立即失效） |
| GET | `/passport/events` | 管理员 | 审计流水 |

## 4. scope

| scope | 含义 | 返回字段 |
|---|---|---|
| `openid` | 登录身份（必需） | `sub`（`cs_` 开头，与邮箱/手机号无关） |
| `profile` | 公开资料 | `nickname` `avatar` `bio` `created_at` |
| `email` | 邮箱（脱敏） | `email`：`a***@qq.com` |
| `phone` | 手机号（脱敏） | `phone`：`138****8000` |
| `offline_access` | 长期授权（30 天） | 额外返回 `refresh_token` |

申请未登记或超出应用上限的 scope → `invalid_scope`。

## 5. 令牌与有效期

| 令牌 | 前缀 | 有效期 | 说明 |
|---|---|---|---|
| 授权码 | `cs_code_` | 60 秒 | 一次性，取用即删（防重放） |
| 访问令牌 | `cs_at_` | 2 小时 | `Authorization: Bearer`；只存 sha256 |
| 刷新令牌 | `cs_rt_` | 30 天 | 每次刷新**轮换**，旧的立即失效 |

`client_credentials` 发的是「应用令牌」（无用户），`/userinfo` 会返回 403。

## 6. 错误码

| error | HTTP | 处理 |
|---|---|---|
| `invalid_client` | 401 | client_id/secret 不对（密钥不要放前端） |
| `invalid_request` | 400 | 缺参数/格式错误（公开客户端未带 PKCE 等） |
| `invalid_grant` | 400 | code/refresh 无效、过期、已用过，或 PKCE/redirect_uri 不匹配 |
| `invalid_scope` | 400 | scope 未登记或超上限 |
| `unsupported_grant_type` | 400 | grant_type 拼错 |
| `access_denied` | 302 | 用户拒绝（回调带 `error=access_denied`） |
| `invalid_token` | 401 | `/userinfo` 令牌无效/过期 |
| — | 429 | 令牌端点限流（客户端+IP 60 秒 30 次） |

## 7. 安全约定

1. **回调地址精确匹配**：不做通配、不做子路径放行；非 https（本机调试除外）一律拒绝 → 从根上堵住开放重定向。
2. **PKCE 必备**：公开客户端强制 `code_challenge`；机密客户端密钥只放服务端。
3. **令牌只存哈希**：库被读走也拿不到可用令牌；授权码取用即删。
4. **单点登出**：用户在任意产品退出（`POST /auth/logout` 或设备下线），该会话发出的通行证令牌立即失效。
5. **用户可随时收回**：App 内「设置 → 通行证授权管理」列出已授权应用并可解除。
6. **审计与限流**：`app.create` / `authorize.approve` / `token.issue` / `token.refresh` / `token.revoke` / 密钥错误等全部留痕（`/passport/events`）。

## 8. CurrentDeveloper 开发者平台（自助接入）

入口：**`https://music.20110208.xyz/developer`**（也支持 `/cm/developer`）。

> **独立页面**：`GET /developer` 是自包含单文件页面（`backend/developer.html`），自带登录/注册，会话存 `csdev.token`，
> **不读写 CurrentMusic 客户端的 `cm.token`**。所以它属于「通行证」而不是音乐客户端——CurrentMusic 里只留一个外链入口。
> 将来把通行证迁到独立域名（如 `developer.20110208.xyz`）时，只需加 DNS + 复用这份 nginx 直通配置，页面本身不用改。

| 能力 | 说明 |
|---|---|
| 新建应用 | 名称 / **应用主页** / **回调地址**（每行一个，精确匹配）/ 需要的 scope / 公开或机密客户端 |
| 获取凭据 | `client_id` 随时代复制；`client_secret` **只在创建或轮换时显示一次**（服务端只存哈希） |
| 获取令牌 | 平台内一键试取**应用令牌**（`client_credentials`），并给出可粘贴的接入代码（授权码 + PKCE 三段） |
| 轮换密钥 | 旧密钥立即失效；可勾选「同时撤销该应用已发出的授权」 |
| 配额与权限 | 每账号最多 **5 个**应用；只能管理自己登记的应用（管理员可管理全部） |

### 部署（nginx 直通）

平台页由后端直接渲染，只要把 `/developer` 直通到后端即可（已在 `music.20110208.xyz` 上启用）：

```nginx
location = /developer {
  proxy_pass http://127.0.0.1:3010/developer;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  add_header Cache-Control "no-cache";
}
location ^~ /developer/ { proxy_pass http://127.0.0.1:3010/developer/; }
```

迁到独立域名（如 `developer.20110208.xyz` / `passport.20110208.xyz`）时：加一条 DNS 解析指向本机 →
复用上面这段 location（`proxy_pass` 不变）→ 页面里的 `{{BASE}}` 会按请求域名自动替换，前后端都不用改代码。

## 9. 自测

```bash
# 临时库起一个实例（不碰线上数据），跑 39 项端到端断言
CM_DB=/tmp/pp.db CM_PORT=3099 python3 backend/cm_server.py &
CM_DB=/tmp/pp.db python3 tools/passport-smoke.py http://127.0.0.1:3099
```

## 变更记录

| 版本 | 内容 |
|---|---|
| 1.2（v1.28.19） | 开发者平台独立于 CurrentMusic 客户端：单文件页面 `GET /developer` + 独立会话 + nginx 直通；客户端移除内置页，仅保留外链 |
| 1.1（v1.28.18） | 新增 CurrentDeveloper 开发者平台：自助登记（每账号 5 个）、主页/回调配置、凭据与轮换、一键试取应用令牌、停用启用 |
| 1.0（v1.28.17） | 首个版本：授权码 + PKCE、刷新轮换、userinfo、introspect、revoke、应用登记、授权管理、审计、单点登出 |
