# Web 与 API 传输优化

针对跨境高延迟、移动网络与中国大陆访问的额外请求开销做以下优化；这些措施不代表已更换线路或部署大陆 CDN。

- 已配置的 HTTPS Web 入口（`music.20110208.xyz`、`music.ctcehs.com`、
  `currentmusic.geekertao.com`、`cm.bileizhen.top`）默认使用当前域名的 `/cm`，
  不再从备用入口绕回主域名。用户显式填写的服务器地址优先，Android NativeApi 仍使用既有默认地址。
- 无请求体的 GET 不再发送 `Content-Type: application/json`，公开跨域 GET 可避免不必要的 OPTIONS。
  带 Authorization 的请求仍按 CORS 规范预检；OPTIONS 返回 `Access-Control-Max-Age: 600`，
  浏览器可复用 10 分钟，认证与接口权限规则不变。
- `python3 tools/deploy-web.py` 将构建产物同步到 `data/app/`，并生成 gzip level 9 副本；
  Web 首页引用 `app.<SHA-256 前 16 位>.js/css`，不依赖 CDN 是否保留 `?v=`；全部资源就绪后
  才切换首页，并保留旧指纹文件供已打开的标签页使用。副本不进入 Android assets，不增加
  APK 体积。`build.sh` 已使用同一发布脚本。
- Nginx 的 `/app/` 开启 `gzip_static on`（需要 gzip_static 模块），静态资源使用预压缩文件。
  API 继续由 Nginx 动态压缩；文本压缩阈值降至 256 字节，代理请求也可压缩。
  不压缩 SSE，不为账号、令牌、管理台或用户数据添加共享缓存。

本机部署配置：`/www/server/panel/vhost/nginx/music.20110208.xyz.conf` 与其
`extension/music.20110208.xyz/mainland-speed.conf`；通用模板见 `deploy/nginx.conf.example`。
配置变更必须先执行 `nginx -t`，通过后再 reload。

验证：`node tools/test-api-transport.cjs`、`tools/run-tests.sh -p test_transport_options.py`、
`tools/run-tests.sh -p test_playlist_schema_upgrade.py`。更新后核验实际 HTTPS 返回的首页、
JS 和 CSS 内容，以及 gzip 解压后与原文件一致；不要把服务器回环 TTFB 当作中国大陆的访问时延。

2026-10-31 本机实测：主脚本传输从动态 gzip 的 297753 字节变为预压缩的 293178 字节
（包含本次新增逻辑，约减少 1.5%）；主要请求时延收益来自备用域名使用同源 API 和减少预检往返。
本次没有中国大陆探测节点，尚未测量各省份/运营商的端到端收益。进一步优化需要大陆运营商实测
或用户已有的合适 CDN/反向代理入口；不自动修改 DNS、不新购服务。

部署时发现旧数据库缺少 `playlists.ncm_order`，而待上线代码在补列前创建对应索引，
导致重启失败。已将索引创建移到补列之后，旧库启动及重复初始化均有回归测试。

## CDN 无末尾斜杠入口

部分 CDN 对 `/app` 内部跟随重定向，最终返回 HTML 但浏览器地址仍是 `/app`。
相对资源 `app.js` 因此变成 `/app.js`（404），而不是 `/app/app.js`。
Web 首页现为 `/app` 和 `/app/` 设置 `/app/` 资源基址，兼容两种入口；
Android `cm.local` 仍使用原来的 assets 根路径。启动诊断也会显示脚本加载失败的 URL，
不再把通用加载超时归因为 WebView 版本过旧。

## 镜像同步与回源排查

所有镜像应回源同一份 `data/app/`，每次 Web 部署自动更新，无需等待 Android 发版。
Android assets 保持构建时的 `app.js?v=...` 引用，Web 部署脚本另生成文件名指纹副本。
参考 `deploy/nginx.conf.example` 配置以下缓存规则：

- `/app/`、`/app/index.html`、SPA 路由、测速页和旧的无文件名指纹资源：
  `Cache-Control: no-store, no-cache, must-revalidate, max-age=0`、
  `CDN-Cache-Control: no-store`。CDN 控制台也必须遵循源站响应头，禁止整站强制缓存 HTML。
- `app.<16 位哈希>.js/css` 可长期缓存；缓存键必须包含完整路径。缺失的脚本、样式返回
  404，不回退到 HTML。旧指纹文件不随新部署删除。
- `/app` 的重定向使用相对 `Location: /app/`，避免 CDN 通过 HTTP 回源时把用户降到 HTTP。
- 修改缓存规则后清理已有 HTML 和旧 `app.js/app.css` 缓存；仅修改源站响应头不会立即
  驱逐已经被 CDN 强制缓存的旧首页。API、登录凭据和用户数据禁止共享缓存。

发布后运行 `python3 tools/check-web-mirrors.py`，从公网逐个获取四个入口的首页及实际引用的
JS/CSS，与本机部署内容比较；HTTP 错误、资源缺失或内容不同均返回失败退出码。
部署逻辑回归：`python3 tools/test-deploy-web.py`（临时目录，不访问运行数据库）。

2026-11-03 排查并修复：`cm.bileizhen.top` 原为 DNS-only CNAME，指向手工填写了
Cloudflare 边缘 IP 的 `cf.bileizhen.top`，公网因此返回 Error 1000
（DNS points to prohibited IP）；`currentmusic.geekertao.com` 的 ESA 回源链路也返回
同一错误。已将 `cm.bileizhen.top` 改为指向实际源站的 A 记录并开启 Cloudflare 代理，
其余域名记录及 SaaS fallback 配置保持原样，ESA 入口随之恢复。
公网核验四个入口的 JS/CSS 均与本机部署一致，两个故障入口的官网及 API 探针均返回 200。

后续若出现同类故障，应核对 A/AAAA/CNAME、回源 Host/SNI，避免回源到 CDN 自己或形成
代理环；本机四个 Host 响应正常不能代表 CDN 公网正常。具体错误含义见
[Cloudflare 官方说明](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1000/)。

## 网页 CDN 与音源设置（2026-11-02）

入口：设置 → 网络与连接 → 服务器与连接 → CDN 与音源，或 `/app/#/network`。

- 进入页面自动从当前设备检测四个官方镜像；每条两次带超时的公开探针请求，校验
  `service=CurrentMusic`、`ok=true` 及 HTTP 状态。仅两次均成功的线路参与最快推荐。
  可手动选择或应用本次最快线路，保存为 `cm.base`；不会自动跳转域名。探针不带登录凭据。
- 音源支持 CurrentMusic（保留既有网易云解析及解灰回退链路）和 LeiZ API，参考 X 侧的
  `LeizAudioClient` 请求协议。LeiZ 自动音质请求 `jymaster`，实际档位以接口返回为准。
  LeiZ 失败不回退 CurrentMusic。X 侧网易云原生直连依赖 Android，网页不提供该选项。
- LeiZ Key 只保存在当前标签页 `sessionStorage`，输入框保存后清空；仅通过 `x-api-key`
  发往固定 LeiZ HTTPS 接口，禁止跟随接口重定向，不附带本站 Bearer 或 Cookie。
  浏览器会话存储不等同于 Android 加密密钥存储；关闭标签页后需重新填写。
- 可指定歌曲 ID 测试所选音源：先解析，再静音加载至 `loadeddata`。解析成功不等于
  播放成功；加载超时单独展示。第三方 CORS、权限、格式和网络问题均可能导致检测失败。
- 歌曲 CDN 支持自动优选、原始线路和手动选择已验证候选。自动测速与设置页共用结果，
  按边缘族在会话中择优；候选必须来自当前歌曲的 `host/hosts`，不会任意改写音频域名。
  指定边缘不适用于当前歌曲时保留原始地址。测速校验 HTTP 状态和音频 MIME，从流中读取
  约 256 KiB 后取消请求，即使服务端忽略 Range 也不读取整个文件；每条最多等待 6 秒。
  展示 HTTPS 总耗时与短样本 KiB/s，不能代表持续带宽。测速失败会移除该族旧优选结果。
- 修改音源/CDN 后下次播放生效；预加载按账号、API 入口、音源与 Key、CDN 设置区分，
  不复用旧设置的地址，异步解析返回时也校验设置是否变化。

验证：`node tools/test-network.cjs`、`node tools/test-api-transport.cjs`、
`python3 tools/check-js-refs.py`、`cd web && npm run build`；浏览器覆盖桌面与手机的
入口、自动测速、失败排除、切换、输入校验与 Key 隔离。第三方真实播放仍取决于有效 Key、
账号权限和用户所在网络的 CORS/连通性，模拟测试不代表公网取流成功。
