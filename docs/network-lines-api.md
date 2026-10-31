# 主站与 CDN 镜像线路测速

测速页：`/app/auto`（`/app/auto/` 会跳转到该地址）。在线接口文档：[线路与测速专题](https://music.20110208.xyz/api-docs/reference/guide-network-lines-api/)，
CurrentStation 的接口目录也已登记全部相关路径。

- `GET /cm/network/lines`：返回四个固定线路及服务端 HTTPS 测速结果，无需登录。
  每条含 `id/name/origin/appUrl/probeUrl/result`，后者含 `available/status/httpStatus/latencyMs`。
  顶层 `perspective=server`、`measuredAt`（Unix 秒）、`cached`、`cacheTtlSeconds=60`、`measuring`。
  首次并发探测，约 5 秒总等待上限；60 秒内复用结果。并发请求返回已有快照或 `measuring=true`
  的未测速目录。暂无线程槽位为 `busy`，总等待超时为 `timeout`，未测速没有 `result`。
- `GET /cm/network/lines?measure=0`：仅线路目录，不发起探测，`measuredAt=null`。
- `GET /cm/network/probe`：返回 `{service:"CurrentMusic",ok:true,now:<Unix秒>}`；
  CORS 可读取，`Cache-Control: no-store`。请求可附 `?t=<随机值>` 避免中间缓存。
- `GET /cm/network/docs`：兼容入口，302 跳转至 `/api-docs/reference/guide-network-lines-api/`；字段与浏览器请求示例统一在新站维护。

浏览器页从用户设备发起两轮 HTTPS 请求，无 Cookie 和 Authorization；需 HTTP 成功且返回正确
服务标识才计成功。两次均成功的线路中按平均耗时标记最快，部分失败会标注不稳定；不自动跳转，
点击入口才进入所选站点。服务端结果单列，不混入本地排名。

线路固定为主站 `music.20110208.xyz`、`music.ctcehs.com`、
`currentmusic.geekertao.com`、`cm.bileizhen.top`。不接受客户端提供的目标 URL，
服务端不跟随重定向、不走环境代理，限制响应大小与并发数量；接口仍受现有 IP 频控约束。
测速为 HTTP 请求总耗时，包含连接、TLS 与响应；不是 TCPing、带宽或全国各运营商测量。

Web 发布：`tools/deploy-web.py` 自动同步 `web/auto.html` 及 gzip 副本到 `data/app/auto.html`，
Nginx 为 `/app/auto` 配置精确静态文件映射（见 `deploy/nginx.conf.example`），避免落入 SPA。
页面为独立 HTML，不依赖音乐客户端脚本；接口不可用时仍有内置线路目录可执行本地测试。

验证：`tools/run-tests.sh -p test_network_lines.py`，以及浏览器桌面/手机尺寸测试。
