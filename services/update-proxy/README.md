# CurrentMusic 专用更新镜像

部署地址：`https://updates.bileizhen.top`；Worker：`currentmusic-updates`。
基于 [hubporg/CF-GitHub-Proxy](https://github.com/hubporg/CF-GitHub-Proxy) 的流式转发实现改造，保留上游 MIT 许可及署名（见 LICENSE）。

仅支持 GET／HEAD `/download/v<版本>/CurrentMusic-Android-v<版本>.apk`，对应 `bileizhen/CurrentMusicX` 的同名 GitHub 发布资产。没有通用代理入口、网站首页或任意仓库转发。Worker 内处理 GitHub 到官方资产 CDN 的 HTTPS 重定向，流式返回文件，支持单段 Range，并限制资产最多 128MB。客户端继续核验 GitHub 发布大小、SHA-256、包名、版本和发行签名。

## 请求验证

Android `UpdateProxy` 对方法、域名、路径、Range、应用标识、密钥编号、时间和随机 nonce 做 HMAC-SHA256 签名。请求有效期 120 秒；Durable Object 拒绝重复 nonce，并限制每个来源 IP 的哈希每分钟 48 次请求。没有凭据或签名错误返回 403，重复请求返回 409，超限返回 429。关闭 workers.dev、预览地址与请求日志。签名请求头只发往专用镜像，不向 GitHub、公用镜像或上游 CDN 转发；不使用用户账号令牌。

这些限制拒绝普通浏览器及未持有凭据的程序，但 APK 内共享密钥可被逆向提取，无法严格证明请求来自未经修改的正版客户端。若需要更强的应用身份验证，应增加服务器短期令牌与设备证明，不能将 User-Agent 或应用标识当作身份凭证。

## 本地构建和部署

仓库根目录的 `update-proxy.properties` 已被 Git 忽略，包含：

```properties
UPDATE_PROXY_URL=https://updates.bileizhen.top
UPDATE_PROXY_KEY_ID=update-v1
UPDATE_PROXY_SECRET=<随机生成的密钥，至少32字符>
```

Android 构建也接受同名环境变量，优先于本地文件；CI 应从安全的 secrets 注入，不能提交密钥。无配置的开发构建隐藏专用镜像并使用 GitHub 默认源；有配置的发行构建默认专用镜像。不要打印 BuildConfig 的密钥字段。

```powershell
cd services/update-proxy
npm ci --ignore-scripts
npm test
npx wrangler login
npx wrangler secret put APP_SECRET
# 输入与 Android UPDATE_PROXY_SECRET 相同的值
npx wrangler deploy
```

`APP_KEY_ID` 由 wrangler.jsonc 配置，须与 Android 配置一致。域名需要属于当前 Cloudflare 账号；自定义域名由 Workers 管理证书和 DNS。密钥更新需要同时部署 Worker 和新的客户端，旧密钥失效后旧客户端自动回退 GitHub。保管本地配置和发行构建凭据；不要复制到日志、公开仓库或更新说明。

## 验证

离线：`npm test` 检查仓库限制、Android／Worker 共用签名向量、过期／篡改拒绝、重放与限流、错误页和非官方重定向拒绝、上游请求不携带签名凭据。

2026-10-06 在线验证：无签名 403，其他仓库路由 404，过期签名 403，合法签名 Range 返回 206 和 APK ZIP 首部，重复签名请求 409。验证记录在 Git 忽略的 `.verification/update-private-proxy-live.json`；记录不包含密钥或签名。

同日电脑经专用镜像完整下载 v1.1.1 的 40,103,206 字节 APK，SHA-256 匹配官方发布。手机签名 Range 在 IPv4 和 IPv6 上均返回 206；当前手机 Wi-Fi 的完整镜像下载出现 TLS 超时或低速，未完成专用镜像完整下载验证，客户端已实际切回 GitHub。专用域名优先 IPv4，保留全部 DNS 备用地址；这不保证所有网络下 Cloudflare 的可达性。22 项更新 JVM 测试通过（含备用地址、损坏文件、取消和源切换），真机更新界面的源切换和明确点击后才安装用例通过。线上网络用例为显式开启，不能将被中断或回退的专用镜像测试计为通过。
