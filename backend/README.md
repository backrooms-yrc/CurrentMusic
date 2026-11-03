# CurrentMusic Backend

CurrentMusic 的自托管后端：账号体系、网易云音乐代理、播放上报、房间/聊天、分享图、通行证与 AI
助手。基于 Python 标准库（SQLite + `ThreadingHTTPServer`），通行密钥验签使用 py_webauthn，不需要 Web 框架或数据库服务。

## 能力

- 通行密钥：WebAuthn/FIDO2 绑定与免密码登录（设备用户验证后无需额外二步验证或密保）；见 [协议](../docs/passkeys-api.md)
- 自建账号：用户名/密码、邮箱/手机验证码注册与登录、**邮箱验证码找回/修改密码**、会话与设备管理
- 按歌词搜索：`type=lyric` 在同次请求内自动补全真实前后文，失败明确显示状态，兼容 X 侧歌词摘要；见 [接口说明](../docs/search-lyrics-api.md)
- 网易云代理：搜索、详情、歌词、评论、歌单、音质解析、MV/视频、云盘、账号绑定
- 逐字歌词：网易云官方 YRC 优先；缺失时由独立 LDDC 服务从 QQ/酷狗/网易云等源补逐字轴，
  最后才回退到自研按行时长估算
- 播放与社区：最近播放/时长、点赞/收藏、歌单、发现页帖子、公共聊天室（SSE）
- 播放页问 AI：DeepSeek + 联网 Search/Fetch + 站内搜歌 + 卡片
- 分享：歌曲分享元数据与服务端分享图（Pillow + segno，可选）
- CurrentStation 通行证：OAuth 2.0 Authorization Code + PKCE
- IP 属地、CDN 边缘健康度、限速与审计

## 环境要求

- Python **3.11+**；安装后端依赖：`python3 -m pip install -r deploy/requirements-auth.txt -r deploy/requirements-search.txt`
- 一个 api-enhanced/NetEaseCloudMusicApi 实例（默认 `http://127.0.0.1:3001`），
  并能提供 `/song/url/v1`、`/lyric/new`、`/comment` 等上游接口
- 可用的网易云 cookie（写到 `CM_NCM_COOKIE` 指向的文件；服务端据此取音源）
- 可选：
  - Pillow + segno + Noto Sans CJK：分享图渲染（缺失时 `/share/song/{id}/image` 返回 503）；
    可执行 `pip install -r deploy/requirements-optional.txt`，并安装 Noto CJK 字体
  - SMTP：邮箱验证码
  - 短信 webhook：手机验证码
  - DeepSeek API key：AI 助手
  - LDDC（GPL-3.0，独立进程）：为没有官方 YRC 的歌曲补真实逐字歌词；
    运行 `deploy/install-lddc.sh` 一键安装，不安装则继续使用自研估算轴
  - Nginx/Caddy：反向代理与 SSE

## 快速开始

```bash
# 在仓库根目录创建 Python 虚拟环境并安装认证依赖。
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -r deploy/requirements-auth.txt
mkdir -p data
cp deploy/backend.env.example data/backend.env
# 编辑路径/域名/可选凭据；初始化和启动必须使用同一份配置。
set -a; . data/backend.env; set +a
python3 backend/manage.py init-db
python3 backend/manage.py create-owner admin --nickname 管理员
python3 backend/cm_server.py
```

生产环境建议用 systemd：见 `deploy/currentmusic.service`。反向代理必须为
`/cm/live/chat`、`/cm/live/ai` 以及直接调用的 `/cm/chat/live`、`/cm/ai/live` 关闭 buffering，否则 SSE 会被攒包；示例见
`deploy/nginx.conf.example`。

## 配置

所有配置都走环境变量。路径默认相对仓库，生产环境建议显式指定数据目录。

| 变量 | 默认 | 说明 |
|---|---|---|
| `CM_PORT` | `3010` | 监听端口（仅绑定 127.0.0.1） |
| `CM_DATA_DIR` | `<repo>/data` | 运行时数据根目录（数据库/头像/分享图等） |
| `CM_DB` | `<CM_DATA_DIR>/cm.db` | SQLite 文件 |
| `CM_AVATAR_DIR` | `<CM_DATA_DIR>/avatars` | 用户头像目录 |
| `CM_RELEASES_DIR` | `<CM_DATA_DIR>/releases` | APK 更新源目录（可选） |
| `CM_X_RELEASES_DIR` | `<CM_DATA_DIR>/releases-x` | 第三方客户端镜像目录（可选） |
| `CM_PASSKEY_ORIGINS` | 官方 HTTPS 入口 | 自托管通行密钥允许的 HTTPS origin，逗号分隔；必须显式列出，不支持通配符 |
| `CM_DEFAULT_HOST` | `localhost` | 请求缺少 Host 头时用于生成链接 |
| `CM_NCM_BASE` | `http://127.0.0.1:3001` | NCM API 基址 |
| `CM_NCM_COOKIE` | `<CM_DATA_DIR>/ncm-cookie` | 网易云 cookie 文件 |
| `CM_AI_KEY` | 空 | DeepSeek API key；空则 AI 降级 |
| `CM_AI_BASE` | `https://api.deepseek.com/v1` | 模型 API |
| `CM_AI_MODEL` | `deepseek-flash` | 模型名 |
| `CM_AI_EFFORT` | `high` | `none/low/high/max` |
| `CM_SMTP_HOST/PORT/USER/PASS/FROM` | 空 | 邮箱验证码 |
| `CM_SMS_WEBHOOK/TOKEN/SIGN` | 空 | 短信验证码 |
| `CM_CAST_CACHE` | `<CM_DATA_DIR>/cast` | 投屏音频缓存 |
| `CM_SHARE_DIR` | `<CM_DATA_DIR>/share` | 分享图缓存 |
| `CM_LDDC_URL` | 空 | LDDC 桥接地址；空=停用，建议 `http://127.0.0.1:3015` |
| `CM_LDDC_TOKEN` | 空 | 桥接访问令牌（`install-lddc.sh` 自动生成并写入 drop-in） |
| `CM_LDDC_TIMEOUT` | `10` | 单次桥接请求超时秒数 |
| `CM_LDDC_RETRY_TTL` | `7200` | 只拿到估算轴时的重试缓存秒数 |

NCM、AI、SMTP、SMS、LDDC 都是可选的；未配置时对应功能返回明确错误或降级，不影响账号/浏览/歌单。
`CM_INTERNAL_PASS` 只用于内部服务登录，自托管通常不需要。
LDDC 的安装/升级见 `deploy/README.md`；它使用独立 venv，后端认证依赖与 LDDC 的独立环境分开安装。

## API

启动后 `GET /cm/station/api-catalog` 返回机器可读目录；`/api-docs/reference/guide-passport-api/` 是通行证协议页。
仓库内的接口说明见：

- `docs/lyrics-api.md`：歌词逐字轴、LDDC 回退与 `wSynth`
- `docs/password-api.md`：邮箱验证码找回/修改密码、验证码命名空间与限流
- `docs/private-roaming-api.md`：私人漫游模式/场景、推荐回调与垃圾桶
- `docs/play-history-sync.md`：播放历史实时写入绑定网易云账号
- `docs/currentmusic-ai.md`：AI 聊天与播放页问AI
- `docs/share-api.md`：分享元数据/图片
- `docs/realip.md`：RealIP 透传策略
- `docs/rooms-design.md`：听歌房
- `docs/third-party-ncm-sync.md`：第三方客户端登录态同步

## 数据库与备份

- 首次启动会自动建表/迁移；也可运行 `python3 backend/manage.py init-db`。
- 备份 `CM_DB` 与 `CM_DATA_DIR` 下的头像/分享图即可；数据库使用 WAL，建议用
  `sqlite3 cm.db ".backup backup.db"` 而不是直接拷贝正在写入的文件。
- `manage.py show-config` 会打印路径和凭据是否配置（不输出密钥）。

## 测试

```bash
./tools/run-tests.sh          # 强制使用 /tmp 临时数据库，绝不动生产库
python3 tools/test-lyric-merge.py
python3 tools/check-open-source.py
```

测试大多为纯逻辑；涉及分享图的测试在 Pillow/segno 缺失时自动跳过。

## 安全与隐私

- 不要提交 `CM_AI_KEY`、SMTP/SMS 凭据、NCM cookie、数据库或 APK；`.gitignore` 已覆盖常见路径。
- 反向代理负责 HTTPS 与真实 IP：本服务信任 nginx 覆盖写入的 `X-Real-IP`，不会接受客户端自带的
  `realIP` 参数。
- 媒体与账号写操作会把 RealIP 传给网易云（见 `docs/realip.md`）；公共只读不传。
- 所有写接口有频控/权限校验；公开部署前请自行做日志保留、备案与合规评估。

## 许可证

项目自有代码使用根目录的 [MIT 许可证](../LICENSE)。第三方依赖与素材保留各自许可。

LDDC 是独立的 GPL-3.0-only 程序，仅以本机 HTTP 方式调用，源码不进入本仓库；
分发时请保留 `THIRD_PARTY_NOTICES.md` 与 LDDC 的来源/许可证说明。
