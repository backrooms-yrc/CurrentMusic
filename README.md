# CurrentMusic

![CurrentMusic](assets/brand/currentmusic-icon.png)

CurrentMusic 的完整开源仓库：Python 后端、Web 播放器、Android WebView 应用、Windows 原生客户端、官网与 API 文档。项目自有代码采用 [MIT](LICENSE) 许可。

- [Web 播放器](https://music.20110208.xyz/app/) · [API 文档](https://music.20110208.xyz/api-docs/)
- [Android Releases](https://github.com/backrooms-yrc/CurrentMusic/releases) · [更新日志](CHANGELOG.md)
- [后端部署](backend/README.md) · [Windows 客户端](windows/README.md) · [贡献指南](CONTRIBUTING.md)

公开库保留原前端壳的提交、标签与 Releases；后端和其他组件以经过审查的源码快照加入。历史私有仓库继续保密，不合并其 Git 历史。运行数据、账号 cookie、服务凭据与官方签名密钥不随代码分发。

## 目录

| 目录 | 内容 |
| --- | --- |
| `backend/` | 账号、通行密钥、网易云网关、播放/歌单、聊天/房间、通行证与 AI |
| `web/` | Web 与 Android 共用的前端源码 |
| `app/` | Java WebView 壳及可重建的前端静态资源 |
| `windows/` | C# / WinUI 3 原生客户端及安装器源码 |
| `deploy/` | systemd、Nginx、PHP 入口、环境变量与备份模板 |
| `site/`、`api-docs/` | 官网与 API 文档站源码 |
| `tools/`、`docs/` | 构建、验证、维护脚本与接口说明 |

## 本地启动后端

需要 Python 3.11+。先在仓库根目录执行：

```bash
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -r deploy/requirements-auth.txt
mkdir -p data
cp deploy/backend.env.example data/backend.env
# 编辑 data/backend.env，设置 CM_DATA_DIR/CM_DB 等路径为当前实例的绝对路径。
# 在初始化和启动之前加载同一份配置。
set -a; . data/backend.env; set +a
python3 backend/manage.py init-db
python3 backend/manage.py create-owner admin --nickname 管理员
python3 backend/cm_server.py
```

后端默认监听 `127.0.0.1:3010`；`GET /health` 可检查存活。创建站长时未提供密码会生成随机密码并仅显示一次。生产部署、外部服务和反向代理配置见 [backend/README.md](backend/README.md) 与 [deploy/README.md](deploy/README.md)。

网易云 API 是独立部署的上游服务，通过 `CM_NCM_BASE` 指定；它的源码和登录 cookie 不包含在本仓库。AI、SMTP、SMS、分享图与 LDDC 均按需配置；没有相应配置时对应能力不可用或降级。账号、歌单等本地能力不依赖这些服务。

## Web 与 Android

需要 Node.js 20+；Android 构建另需 JDK 17、Android SDK platform 34 和 build-tools 34.0.0。

```bash
npm --prefix web ci
python3 tools/check-js-refs.py
npm --prefix web run build
# 只部署 Web：先同步资源，再切换带内容指纹的 index.html。
python3 tools/deploy-web.py --target data/app

# Android：版本默认读取 web/src/version.js，也可显式设置 VER_NAME/VER_CODE。
export ANDROID_HOME=/path/to/android-sdk
bash build.sh
```

前端产物位于 `app/src/main/assets/www/`；APK 位于 `dist/`。首次 Android 构建会创建本地自签名密钥；自行签名的安装包无法覆盖官方签名版本。签名密码通过 `CM_KS_PASS` 配置，不要提交密钥。Android 最低版本为 7.0（API 24）。客户端可在设置中切换服务器。

## 官网与文档

```bash
# 官网复用 web/node_modules，输出到 data/www。
node site/build.mjs
# 文档可独立从当前路由和登记表构建。
npm --prefix api-docs ci
npm --prefix api-docs run build
npm --prefix api-docs run publish
```

如需完整上游参数摘录，构建文档时设置 `NCM_API_DIR` 指向独立的 api-enhanced 源码目录。缺失上游源码时仍生成自有接口、权限登记与专题，明确标注上游资料未附带。见 [文档构建说明](api-docs/README.md)。

## 验证与安全

```bash
tools/run-tests.sh                  # 强制使用临时数据库与数据目录
python3 tools/test-api-docs.py
python3 tools/test-open-source.py
python3 tools/check-open-source.py   # 检查所有已跟踪文件；只报告位置，不打印密钥
```

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题见 [SECURITY.md](SECURITY.md)，公开边界与迁移记录见 [开源清单](docs/open-source-checklist.md)。媒体与账号写操作的 RealIP 传递方式见 [docs/realip.md](docs/realip.md)。

## 许可与第三方资源

项目自有代码使用 [MIT](LICENSE)。依赖、图标字体、上游文档与可选服务保留各自许可，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。LDDC 独立安装并通过本机 HTTP 连接，不包含其源码。挂件目录只提供元数据；第三方图片、音乐、用户头像与其他服务内容不属于 MIT 授权范围。

CurrentMusicX 由社区开发者在 [bileizhen/CurrentMusicX](https://github.com/bileizhen/CurrentMusicX) 独立维护，其仓库与发布流程保持独立。
