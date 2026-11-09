# CurrentMusic for Windows 1.0.0

此页记录历史 WinUI 3 版本。Windows 2.0 原生 Go 技术原型及实机验收见 [MyGo 开发目录](mygo/README.md)。

C# / WinUI 3 原生 Windows 音乐客户端。支持 Windows 10 2004（build 19041）及以上与 Windows 11；提供 x64、ARM64 自包含 MSI。工程路线、验收范围与未覆盖的验证见 [五阶段计划](../docs/windows-five-phase-plan.md)。

## 功能

- 原生账号表单：密码或邮箱验证码登录；注册支持手机/邮箱验证码；找回密码；验证器 2FA / 恢复码与密保挑战。会话按 HTTPS API 地址隔离，保存在 Windows 凭据管理器，偏好 JSON 不存密码、会话或音源链接。
- 歌曲、歌手、专辑、歌单搜索，30 项分页；打开专辑、歌手作品或歌单；网易云公开歌单详情使用后端的前 100 首预览，歌手详情为热门前 100 首。
- 原生 MediaPlayer：播放/暂停、上一首/下一首、进度、音量、列表/单曲循环、不重复随机与上一首历史；8 档音质；音源失败刷新 CDN，进一步失败降为极高 MP3，重试有上限。
- 音频时钟驱动的行/逐字歌词、翻译、点击歌词跳转、置顶可拖动桌面歌词窗口。
- 每日推荐、猜你喜欢、私人漫游（默认/熟悉/探索/放松/专注，需要网易云绑定）；云端喜欢、历史与歌单新建/重命名/删除/增删歌曲；网易云手机号绑定和歌单同步，同步歌单只读。
- 读取旧版云端收藏快照。独立收藏写接口目前服务端未提供；新收藏可通过云端歌单管理。
- 系统媒体键与 SMTC 元数据/进度，托盘恢复/退出、可选关闭到托盘、单实例、Ctrl+空格/左右键/F 快捷键；主题与偏好持久化；实际收听时间上报。

## 安装与升级

安装文件名为 `CurrentMusic-For-Windows-1.0.0-x64.msi` 或 `CurrentMusic-For-Windows-1.0.0-arm64.msi`。普通 Intel / AMD 电脑选 x64，Windows on ARM 电脑选 ARM64。MSI 安装到 `C:\Program Files\CurrentMusic`，创建开始菜单快捷方式，需要管理员权限。包含 .NET、Windows App SDK 与 app-local Visual C++ CRT，无需另装开发环境。Windows N 版本需要系统 Media Feature Pack。

双击 MSI 按向导安装，然后从开始菜单启动 CurrentMusic。旧版运行时先从托盘退出，再运行新版 MSI 升级。Windows 设置可修复或卸载；偏好与凭据保留供重装使用，需移除凭据时先在应用中退出登录。当前采用手动 MSI 更新，不配置自动下载/执行更新源。

本次交付为未做 Authenticode 签名的安装包：没有配置 Windows 代码签名证书。MSI 的 SHA-256 校验文件随产物生成。未向公开仓库或 Releases 发布，不触发 Android / X 侧发布。

最终本机交付路径、校验值与验证记录见 [交付记录](../docs/windows-delivery.md)。

## 工程与构建

- `CurrentMusic.Core`：HTTP/会话错误契约、偏好、歌曲模型、播放队列与歌词时间轴。
- `CurrentMusic.Windows`：WinUI 3 XAML、Windows 凭据、MediaPlayer / SMTC、托盘与桌面歌词。
- `CurrentMusic.Core.Tests`：内存 HTTP 替身、临时偏好目录、队列/歌词/会话测试；`--live` 额外只读验证真实探针、搜索与歌词。不创建生产用户、不访问生产数据库。
- `installer`：WiX 4.0.6 MSI 清单生成、CRT 打包与安装验证。生成器只读取发布目录。

构建依赖 .NET 10 SDK、支持 .NET 10 / WinUI 开发的 Visual Studio Build Tools、Windows SDK 26100 与 C++ redistributable 文件。Windows App SDK 固定 2.6.4，构建期间需 NuGet 网络。

```powershell
cd windows
dotnet run --project CurrentMusic.Core.Tests -c Release
dotnet publish CurrentMusic.Windows/CurrentMusic.Windows.csproj -c Release -p:Platform=x64 -r win-x64 -o artifacts/win-x64
./installer/build.ps1 -Architecture x64
# 自动安装测试只在隔离的 Windows CI/测试机运行，会安装和移除应用
./installer/test-install.ps1 -Installer artifacts/installers/CurrentMusic-For-Windows-1.0.0-x64.msi
```

ARM64 构建参数为 `-p:Platform=ARM64 -r win-arm64 -o artifacts/win-arm64`，打包参数 `-Architecture arm64`。安装测试脚本当前在 x64 Windows 执行，ARM64 运行验收需 ARM64 Windows。

```sh
cd windows
dotnet run --project CurrentMusic.Core.Tests -c Release -- --live
```

Linux 可以测试 Core；WinUI 编译、打包和安装检查通过 `.github/workflows/windows.yml` 在 Windows runner 执行。公开仓库 CI 产物保留 14 天；本机下载的 MSI 不受该过期时间影响。

## 数据与诊断

偏好：`%LOCALAPPDATA%\CurrentMusic\Windows\settings.json`。崩溃记录：同目录 `logs\last-crash.txt`，仅记录异常类型、调用栈与时间，不记录异常消息、密码、会话、音源 URL。切换 API 地址会停止旧播放并恢复对应地址的安全会话。HTTP 失败不自动重试写操作，避免重复增删。

显式诊断参数 `--smoke-test=<报告绝对路径>` 使用独立临时偏好、内存模拟 API 与独立凭据条目；检查原生窗口、表单、列表、主题、桌面歌词、MediaPlayer / SMTC 初始化及 MP3/FLAC 原生解码。该模式不访问真实账号、不写生产接口，不证明真实用户登录或实际扬声器输出已验收。
