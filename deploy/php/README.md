# CurrentMusic PHP 入口

把 `deploy/php/index.php` 放到 PHP 站点目录（或 `/cm/` 子目录），它会将请求透明转发到
本机 Python 后端（默认 `http://127.0.0.1:3010`）。适用于只有 PHP-FPM、没有 nginx
`proxy_pass` 的共享主机或宝塔站点。

> **不要**在未修复 php2shell 的 PHP 上启用本入口。入口会检查版本，以下版本才放行：
> **8.2.35 / 8.3.36 / 8.4.27 / 8.5.12+**。当前如果仍显示 503，说明 PHP 还没打补丁。

## 文件

| 文件 | 用途 |
|---|---|
| `index.php` | 固定上游的透明反向代理，支持 JSON、二进制、Range、SSE |
| `.htaccess` | Apache 重写与 `Authorization` 头透传 |
| `nginx.conf.example` | nginx + PHP-FPM 的 `/cm/` location 示例 |

## 配置

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `CM_UPSTREAM` | `http://127.0.0.1:3010` | Python 后端地址；固定值，不能由请求参数控制 |
| `CM_PHP_PREFIX` | 自动 | 挂在 `/cm/` 时设为 `/cm`；根目录部署留空 |

PHP-FPM 池建议：

```ini
; 入口是长连接/SSE，不要用太小的 pm.max_children
pm.max_children = 32
request_terminate_timeout = 3600
```

Web 服务器需要允许 4MB 请求体（头像/聊天图片走 base64，后端上限 2MB）：

```ini
client_max_body_size 4m;
```

## nginx

把 `nginx.conf.example` 合并进站点 `server{}`，修改：

- `fastcgi_param SCRIPT_FILENAME` 为 `index.php` 的绝对路径；
- `fastcgi_pass` 为实际 PHP-FPM socket；
- 如果站点通过 Cloudflare/反代访问，确保 nginx 的 `real_ip` 模块把
  `REMOTE_ADDR` 还原成真实用户 IP（入口会把 `REMOTE_ADDR` 写入 `X-Real-IP`）。

`/app/` 静态资源继续由 nginx 直接托管，不要走 PHP。

## Apache

把 `index.php` 和 `.htaccess` 放进 `/cm/` 目录，启用 `mod_rewrite`。如果
`Authorization` 仍为空，确认 `.htaccess` 中的 `SetEnvIf Authorization` 未被
`AllowOverride` 禁止。

## 验证

```bash
# 后端健康检查（经 PHP 入口）
curl -i https://example.com/cm/health

# 未修复 PHP 会得到 503 + 明确提示
# 修复后应得到 200 JSON {"ok":true,...}

# 分享图/二进制
curl -I https://example.com/cm/share/song/1492584510/image

# SSE（需要登录 token）
curl -N -H "Authorization: Bearer <token>" https://example.com/cm/live/ai
```

## 限制与注意

- 入口固定上游，不能通过 URL 参数代理任意地址；不要把 `CM_UPSTREAM` 指到公网。
- PHP 版本门禁不可关闭；未打补丁的 PHP 会直接 503。
- SSE 依赖 `fastcgi_buffering off` 与 PHP 输出缓冲关闭；入口已调用
  `ob_end_clean` / `flush`，但 Web 服务器层也必须关闭缓冲。
- 大文件下载走 PHP 流式转发，会占用一个 PHP-FPM worker；高并发下载建议继续用
  nginx `proxy_pass`，PHP 入口只作为兼容方案。
- 入口不处理静态 `/app/`，否则会把 1MB 的 JS/CSS 也塞进 PHP。
