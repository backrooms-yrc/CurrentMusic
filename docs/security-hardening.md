# 安全加固记录（2026-10-22）

本次核查覆盖后端运行栈、nginx 配置与近期公开 CVE，并完成可在不改业务协议的前提下
立即落地的加固。需要维护窗口处理的事项单列在最后。

## 运行栈与版本

| 组件 | 当前版本 | 说明 |
|---|---|---|
| Python | 3.11.2-6+deb12u9 | Debian 12 安全维护分支（本次补 security 源后升级） |
| nginx | 1.28.3 | 宝塔自编译（Lua/WAF/well-known 依赖） |
| OpenSSL | 3.0.22 | 系统库（本次由 3.0.20 升级） |
| SQLite | 3.40.1 | 系统库 |
| Pillow | 9.4.0-1.1+deb12u1 | Debian 安全补丁版，可选依赖 |
| Node | 22.23.2 | NCM API（NCM API 部署目录，无 lockfile） |

> 2026-10-22 补上了缺失的 `bookworm-security` 源并升级 Python/OpenSSL；
> 此前系统只有 main/updates/backports，安全补丁无法进入。

## CVE 核对结论

### nginx 1.28.3（需维护窗口升级）

nginx 官方安全公告显示 1.28.3 **仍受多项 2026 公告影响**，包括：

- CVE-2026-42533（map + 正则捕获，major）
- CVE-2026-15176（alias + rewrite）
- CVE-2026-97629（TLS session ticket 会话伪造）
- CVE-2026-95101（HTTP/3 请求体注入）
- CVE-2026-97205（异步文件 I/O UAF）
- CVE-2026-60005 / CVE-2026-56434 / CVE-2026-42055 / CVE-2026-48142
- CVE-2026-9256 / CVE-2026-42945 / CVE-2026-42946 / CVE-2026-42934
- CVE-2026-40460 / CVE-2026-40701

官方修复版本为 **1.30.6+ / 1.31.7+**；最新稳定版为 1.30.6。由于本机 nginx
由宝塔编译、站点依赖 Lua/WAF/well-known 模块，不能直接替换官方二进制；升级
需要在维护窗口用相同模块集重新编译。另注意本机 nginx 静态链接自带 OpenSSL，
系统 OpenSSL 3.0.22 的升级**不会**覆盖它，重编译时需一并更新内置 OpenSSL。

已先做配置缓解：

- `ssl_protocols TLSv1.2 TLSv1.3`（移除 TLS 1.1）
- `ssl_session_tickets off`（缓解 CVE-2026-97629）
- 未启用 `listen ... quic`；HTTP/3 CVE 不可达
- 本站未使用 `rewrite` + `alias` 组合；`map` 无正则捕获
- `server_tokens off`
- 增加 HSTS includeSubDomains、nosniff、SAMEORIGIN、Referrer-Policy、Permissions-Policy

### Pillow 9.4.0

Debian 已回填 2023–2024 的多个修复，但 2026 仍有 PSD/PDF/RankFilter/ImageCms
等 CVE（如 CVE-2026-59197、CVE-2026-59205、CVE-2026-42311）。后端的图片路径
已限制为 **JPEG/PNG/WebP**（AI 图片额外允许 GIF 首帧），并在解码前限制
**2500 万像素**，不走 PSD/PDF/ImageCms 路径，显著降低暴露面。彻底解决需将
Pillow 升到 12.3+（本机系统包当前无该版本，需单独打包/venv）。

### Python 3.11 / Node

已补 Debian security 源并把 Python 升到 `3.11.2-6+deb12u9`、OpenSSL 升到
`3.0.22`。后续随 `apt` 继续跟进 `3.11.2-6+deb12uN`。NCM API 目录没有
`package-lock.json`，`npm audit` 无法运行；建议先提交 lockfile，再在 CI 中执行
`npm audit --omit=dev`。本次未改动第三方 NCM API 代码。

## 已落地的代码加固

1. **SSRF**：新增 `backend/cm_net.py`，分享图封面与 `/cm/img` 代理只允许
   `music.126.net`，禁止重定向、禁止 URL 凭据、限制端口 80/443 与读取字节。
   此前分享图对用户可控的 `pic` 直接 `urlopen`，可访问本机/云元数据地址。
2. **图片解压炸弹**：新增 `backend/cm_image.py`，统一格式白名单 + 像素上限，
   头像、分享封面、聊天图片送 AI 前均走该入口；头像超限直接 400。
3. **认证限速**：登录/注册/邮箱/短信验证码入口单独 30 次/分钟/IP，避免撞库
   只受全站 300/min 限制。
4. **安全响应头**：后端所有响应统一加 nosniff / SAMEORIGIN / Referrer-Policy /
   Permissions-Policy；nginx 静态 `/app/` 同步补齐。
5. **图片代理响应**：`/cm/img` 校验 `Content-Type` 必须为 `image/*`，加 nosniff。

## 验证

- `python3 -m unittest`：238 个测试通过、4 个跳过。
- 分享图 `/cm/share/song/1492584510/image` 正常返回 JPEG。
- `/cm/img` 对 `http://127.0.0.1:3010/health` 返回 400；合法网易云封面返回 200。
- TLS 1.1 握手被拒绝；TLS session ticket 不再下发。
- 认证限速第 31 次请求被拒绝。
- 后端响应头实测含 nosniff / SAMEORIGIN / Referrer-Policy / Permissions-Policy。

## 待办（需维护窗口）

1. nginx 1.28.3 → 1.30.6+（保留宝塔模块集），升级后重新跑 `nginx -t` 与全站回归。
2. Pillow 9.4.0 → 12.3+（或迁移到独立 venv），随后移除对 9.x 的依赖。
3. 为 `NCM API 部署目录` 生成 lockfile 并接入 `npm audit`。
4. 每次 Debian 安全更新后重启后端并复跑本页验证项。

## 参考

- nginx security advisories: https://nginx.org/en/security_advisories.html
- nginx downloads: https://nginx.org/en/download.html
- Debian Pillow tracker: https://security-tracker.debian.org/tracker/source-package/pillow
- Debian Python 3.11 tracker: https://security-tracker.debian.org/tracker/source-package/python3.11
