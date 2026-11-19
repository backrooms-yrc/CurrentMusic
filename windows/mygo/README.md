# CurrentMusic for Windows 2.0

MyGo 原生桌面客户端。目标系统为 Windows 11 25H2 x64。阶段 2 接通 CurrentMusic 账号和曲库，原型的本地数据可从「演示曲库」打开，真实音频通过 C++/WinRT 媒体桥播放。

第二轮以冻结版 Web 用户流程为验收基线。参见[功能清单、计分命令与本轮验收记录](parity/README.md)。

## 构建与运行

固定 Go 1.27.3、MyGo v0.8.3（commit 5add3817c74b）及 Windows SDK 10.0.26100.0。完整构建需要 Visual Studio Build Tools 的 Desktop development with C++ 工作负载。从 x64 Developer PowerShell 执行。

~~~powershell
./windows/mygo/build.ps1
./windows/artifacts/mygo-preview/CurrentMusic.exe
~~~

CurrentMusic.exe 与 CurrentMusic.Media.dll 放在同一目录。仅检查界面时，可在普通 PowerShell 构建 x64 EXE。已有配套媒体桥时，也可将 DLL 放到 EXE 旁继续音频验收。

~~~powershell
./windows/mygo/build.ps1 -UIOnly
./windows/artifacts/mygo-ui/CurrentMusic.exe
~~~

加上 `-compact-preview` 参数可直接启动最小尺寸窗口，便于手工验证底栏和队列抽屉。

移交的 Linux 构建使用 Go 1.27.3、Clang 19／LLD 和 Windows SDK 26100。移交记录核对过 x64 PE 和九个媒体桥导出。Windows N 的音频验证需要系统媒体组件。

## 界面检查

- 曲库采用固定青绿色主题，侧栏按浏览、我的音乐和应用分组。搜索、喜欢和歌单共用曲目行样式。单击选中，双击或 Enter 播放，右键可选下一首播放、加入队列和加入歌单。
- 常驻播放栏分为封面与曲目信息、传输控制与进度、音质与音量及队列。窄窗将进度放到第二行。队列在宽窗停靠，在窄窗覆盖内容区，播放栏始终可操作。关闭队列后焦点回到队列按钮。
- 点底栏曲目信息展开播放页。宽窗左封面、右同步歌词，窄窗默认显示歌词并可切换到封面。播放页背景从封面取色。可点歌词跳转，手动滚动后可回到当前行。
- Ctrl+F 聚焦搜索，Ctrl+Space 播放或暂停，Ctrl+Left／Right 切歌，F11 全屏，Escape 返回或关闭抽屉。

侧栏和工具栏参考 Onevra，播放页与曲库布局参考 MySpotify。固定 Onevra `v0.2026.18`，使用 `SidebarSection` 和 `Badge`。MyGo 仍为 `v0.8.3`。随组件解析的间接依赖包括 `purego v0.11.2`、`x/image v0.47.0` 和 `x/net v0.61.0`。[Onevra Gallery](https://oneo-me.github.io/onevra/docs/components/) · [MySpotify 界面截图](https://github.com/margbug01/MySpotify#截图)

~~~powershell
./windows/mygo/build.ps1 -Output windows/artifacts/mygo-onevra-ui
$env:CURRENTMUSIC_NATIVE_CAPTURE_DIR = Join-Path $PWD 'windows/artifacts/mygo-onevra-ui/native'
go -C windows/mygo test -mod=readonly -count=1 -v -run '^(TestCaptureUIRefresh|TestCaptureCloudPreview)$'
Remove-Item Env:CURRENTMUSIC_NATIVE_CAPTURE_DIR
~~~

UI 改造在 Windows 11 24H2 x64（26100.9711）通过构建、Go 测试、`go vet` 和原生窗口截图。截图覆盖浅深色、1184 × 721 DIP 宽窗及 584 × 281 DIP 最小窗，使用测试数据。自动交互覆盖最小窗队列打开时的传输控制、焦点恢复、歌词跟随、音质菜单、队列播放模式和移除。WinRT 回环 MP3／FLAC 使用同一播放控制器验证了播放、暂停、拖动、调音量、切歌和换档续播。

~~~powershell
go -C windows/mygo test -mod=readonly -c -o ../artifacts/mygo-onevra-ui/CurrentMusic.MediaProbe.test.exe
$env:CURRENTMUSIC_MEDIA_FIXTURE_DIR = Join-Path $PWD 'windows/artifacts/mygo-fixtures'
./windows/artifacts/mygo-onevra-ui/CurrentMusic.MediaProbe.test.exe '-test.run=^TestWindowsQualityResume$' '-test.v=true'
Remove-Item Env:CURRENTMUSIC_MEDIA_FIXTURE_DIR
~~~

25H2、真实显示缩放、微软拼音候选框、实体媒体键和物理音频输出仍待人工验收。

生成曲库、播放页和队列的 18 张无窗口渲染图，覆盖浅深主题与 1200 × 760、960 × 540、600 × 320 三种客户区。

~~~powershell
Push-Location windows/mygo
$env:CURRENTMUSIC_DESIGN_DIR = Join-Path $PWD '../artifacts/mygo-ui-render'
go test -mod=readonly -count=1 ./...
go vet -mod=readonly ./...
Pop-Location
~~~

原生窗口客户区截图通过 MyGo 的 `Window.CapturePage` 取得。它使用真实的 Windows 窗口尺寸，截图范围是应用内容。

~~~powershell
$env:CURRENTMUSIC_NATIVE_CAPTURE_DIR = Join-Path $PWD 'windows/artifacts/mygo-ui-native'
go -C windows/mygo test -mod=readonly -count=1 -v -run '^TestCaptureNativePreview$'
Remove-Item Env:CURRENTMUSIC_NATIVE_CAPTURE_DIR
~~~

## 第一阶段真机验收

1. 记录 Windows 版本、build、架构、物理播放端点与系统默认混音格式。在 100%、150%、200% 显示缩放下验证窗口调整、贴靠、深浅主题、最小窗、长标题和可点击范围。用微软拼音输入并选词，检查候选框、Tab 顺序和焦点环。在真机执行搜索 → 播放 → 打开歌词 → 加入队列，并采集曲库、展开播放页和队列截图。
2. 用 FFmpeg 生成四个合成样本。每个样本约 60 秒，每 15 秒升高音高。将样本放在可信的测试 HTTPS 静态目录，先确认每个地址返回 206 和匹配的 Content-Range，再在设置中打开测试音源，验证声音、暂停、续播和前后 Seek。应用以 Windows 共享模式播放，音源采样率与位深显示为音源规格。
3. 对 MP3 与两种 FLAC 分别做至少 20 次播放中进度拖动。每次松手后等待「定位完成」，另记未能完成的拖动。通过条件为 P95 ≤2,000 ms、最大位置误差 ≤500 ms。另测暂停时定位后保持暂停，再从目标位置续播。
4. 用独立测试账号及实际歌曲 ID 验证官方 HTTPS MP3／FLAC。标准或极高档用于 MP3，无损档用于 FLAC。成功取址后会尝试撤销测试会话，验收记录只保留格式、测量和错误类别。
5. 打开两个音源，通过实体媒体键操作播放／暂停、上一首和下一首。确认 Windows 仅显示一个 CurrentMusic 系统媒体会话，系统进度与应用同步，退出后会话消失。

~~~powershell
./windows/mygo/make-fixtures.ps1
curl.exe -f -sS -D - -o NUL -H "Range: bytes=0-1023" $sampleUrl
~~~

### 命令行媒体回归

在完整构建后，将测试 EXE 编译到媒体桥旁。测试用同一个 Go 媒体控制器打开样本，检查 HTTP 206、真实 MediaPlayer 位置推进、正反向 Seek、暂停定位和续播。测试日志仅记录文件名、状态及时间。界面拖动、实体媒体键和物理听音仍按真机验收步骤执行。

~~~powershell
Push-Location windows/mygo
go test -mod=readonly -c -o ../artifacts/mygo-preview/CurrentMusic.MediaProbe.test.exe
Pop-Location
$env:CURRENTMUSIC_MEDIA_FIXTURE_BASE = 'https://your-test-host.example/fixtures/'
./windows/artifacts/mygo-preview/CurrentMusic.MediaProbe.test.exe '-test.run=^TestWindowsMediaFixtures$' '-test.v=true' '-test.timeout=12m'
Remove-Item Env:CURRENTMUSIC_MEDIA_FIXTURE_BASE
~~~

测试也可使用 `CURRENTMUSIC_MEDIA_FIXTURE_DIR` 指向合成样本目录，临时启动仅监听回环地址的 HTTP 服务。该模式用于验证媒体桥和解码器。

### 2026-11-10 移交记录

| 检查项 | 结果 |
| --- | --- |
| 源码和 ZIP | 本地与远端 main 起点均为 ab2c5208，开始时工作区干净。下载目录的 arm64 ZIP 包含旧版 WinUI 的 CurrentMusic.Windows.exe。可访问目录中未找到本次 MyGo x64 移交 ZIP。 |
| Windows 启动 | Windows 11 24H2 x64，build 26100.9711。在实际窗口完成中文搜索、单击选中、Enter 启动演示播放、展开歌词及右键加入队列。真机发现快速按 Enter 时可能丢失按键，改为处理按下事件后复测通过。`windows/artifacts/mygo-ui-native/` 保存深浅色曲库、深色播放页和宽窗停靠队列。 |
| 界面验证 | Go 测试覆盖播放键焦点、点歌词跳转、滚动后回到当前行、抽屉焦点恢复和拖动 Seek 仅提交一次。MyGo 在 100% 系统缩放下捕获了最小窗的 584 × 281 DIP 客户区，覆盖浅深色曲库、播放页及队列。600 × 320 DIP 的点击区以 100%、150%、200% 模拟比例验证。拼音候选框和 150%、200% 系统缩放仍待手工验收。 |
| 测试样本 | 生成 44.1 kHz MP3、44.1 kHz 16-bit FLAC、96 kHz 24-bit FLAC、48 kHz AAC-LC/M4A。四个文件均通过 FFmpeg 解码检查，本地 HTTPS 静态服务器均返回 HTTP 206 与 1,024 字节，附 SHA-256。 |
| 媒体桥构建 | 使用隔离的 MSVC 14.44 和 SDK 26100 完成 `build.ps1` 的完整构建，核对了 x64 DLL 的九个 ABI 导出。`windows/artifacts/mygo-preview/` 提供 EXE、DLL、媒体测试 EXE 和 SHA-256。 |
| 共享模式音频与 Seek | RDP 连接后，24H2 的默认播放端点为远程音频，共享混音格式实测 44.1 kHz、立体声、32-bit float。四种回环 HTTP 样本均验证 MediaPlayer 位置推进、暂停定位和续播。网络 HTTPS、物理听音、界面拖动、实体媒体键和唯一媒体会话仍待真机验收。 |
| 官方音源 | 待提供独立测试账号和实际歌曲 ID。 |
| 源码检查 | Go 测试、Go vet、仓库开源检查与 Gitleaks v8.30.1 脱敏扫描通过。 |

### 24H2 远程音频回归

96 kHz FLAC 在紧接着提交第二次 Seek 时出现 MediaPlayer 失败事件。原样本等待 700 毫秒后可完成 20 次，添加 FLAC seek table 后连续提交仍复现。控制器现在逐次等待 SeekCompleted，之后留出 750 毫秒让 MediaPlayer 完成流切换。阶段 3 回归也在刚打开音源时复现过中止，首次 Seek 同样等待流稳定。等待中的请求只保留最新目标，延迟从提交时计入。

| 音源规格 | 成功次数 | Seek P95 | 最大位置误差 |
| --- | ---: | ---: | ---: |
| MP3 44.1 kHz | 20/20 | 850 ms | 50 ms |
| FLAC 44.1 kHz／16-bit | 20/20 | 850 ms | 0 ms |
| FLAC 96 kHz／24-bit | 20/20 | 850 ms | 50 ms |
| AAC-LC/M4A 48 kHz | 2/2 | 849 ms | 10 ms |

逐次测量见 `windows/artifacts/mygo-preview/media-loopback-rdp-serialized.txt`。96 kHz FLAC 额外提交三个连续目标，仅收到最后一个目标的完成事件，目标 28,000 ms，实测 28,050 ms。

已按要求提前进入阶段 2。25H2、HTTPS 样本、物理输出、实体媒体键、拼音及实际缩放仍在阶段 1 待补验清单。

## 第二阶段账号与曲库

- 在「设置 → 服务器」选择主站或镜像，或输入自定义 HTTPS API 基址，例如以 `/cm` 结尾的完整地址。切换时停止当前媒体、取消旧请求并清空当前曲库状态。
- 在「CurrentMusic 账号」使用用户名和密码，或发送并填写邮箱验证码。开启验证器两步验证的账号可输入 TOTP 或恢复码。开启密保的账号会显示问题并验证答案。
- 正式会话保存在 Windows 凭据管理器，键由规范化 API 基址和用户 ID 组成。设置文件 `%LOCALAPPDATA%\CurrentMusic\MyGo\settings.json` 保存当前 API 基址和各基址上次登录的用户 ID。启动恢复时通过 `/auth/me` 核对账号。退出会删除本机会话并尝试在原服务器撤销会话。
- 在曲库输入关键词后按 Enter 或点「搜索歌曲」。可翻页、选择歌曲查看元数据和查询详情。已登录用户可以双击或按 Enter 取址播放，也可通过曲目菜单修改喜欢和添加到云端歌单。
- 「云端歌单」支持创建、修改、删除以及添加和移除曲目。网易云同步歌单沿用 Web 的只读口径。

~~~powershell
./windows/mygo/build.ps1 -Output windows/artifacts/mygo-stage2
./windows/artifacts/mygo-stage2/CurrentMusic.exe

$env:CURRENTMUSIC_TEST_CREDENTIALS = '1'
$env:CURRENTMUSIC_NATIVE_CAPTURE_DIR = Join-Path $PWD 'windows/artifacts/mygo-stage2/native'
go -C windows/mygo test -mod=readonly -count=1 -v -run '^(TestCloud|TestWindowsCredentialScope|TestCaptureCloudPreview)'
Remove-Item Env:CURRENTMUSIC_TEST_CREDENTIALS,Env:CURRENTMUSIC_NATIVE_CAPTURE_DIR
~~~

Windows 11 24H2 x64 完整构建、Go 测试和 `go vet` 已通过。本地 HTTPS 契约测试覆盖登录挑战、查询和分页、会话恢复、喜欢、歌单曲目写入、切服取消旧请求和重定向拦截。界面测试从搜索框提交关键词，再选中结果按 Enter 发起取址。用临时通用凭据验证了 Windows 凭据写入、读取、按基址和账号隔离及删除。后端在临时数据库上通过密保、密码重置及网易云歌单顺序的 20 项回归。主站公开搜索和歌曲详情已实际请求验证，源码凭据扫描及开源检查通过。

构建、SHA-256、定向测试日志与原生截图位于 `windows/artifacts/mygo-stage2/`。截图使用测试数据。独立账号的真实登录、邮件收取和云端写入仍待验收。

## 第三阶段播放与歌词

- 从曲库、喜欢或云端歌单播放时，队列使用当时已加载的曲目。右键可插入下一首或追加，队列内可跳播、移除曲目以及切换顺序、列表循环、单曲循环和随机模式。单曲循环只在自然播完时触发。
- 取址遇到连接错误、服务端错误或无效音源时刷新重试一次。切换音质时使用旧音源最后的 MediaPlayer 位置，等新音源完成定位后按原播放状态继续。播放页的采样率与位深标为音源规格，输出仍使用 Windows 共享模式。
- 展开页显示 HTTPS 专辑封面并为背景取色，曲库仍使用固定主题。归一化歌词支持逐字时间轴、逐行回退、翻译和估算逐字标记。高亮、自动跟随及歌词点击定位使用 MediaPlayer 的实际位置。
- 实际播放推进才计入收听。拖动、缓冲、暂停和换档引起的时间差会过滤。尚待确认的记录保存在 `%LOCALAPPDATA%\CurrentMusic\MyGo\pending-listens.json`，按 HTTPS API 基址和账号重试。退出时补报尾段，离线时在同一账号下次恢复会话后重试。收听上报要求后端支持 `/plays/capabilities` 和幂等 `clientPlayId`。网易云增量和设备名见[听歌历史与时长同步](../../docs/play-history-sync.md)。

~~~powershell
./windows/mygo/build.ps1 -Output windows/artifacts/mygo-stage3
go -C windows/mygo vet -mod=readonly ./...
go -C windows/mygo test -mod=readonly -c -o ../artifacts/mygo-stage3/CurrentMusic.MediaProbe.test.exe
$env:CURRENTMUSIC_MEDIA_FIXTURE_DIR = Join-Path $PWD 'windows/artifacts/mygo-fixtures'
./windows/artifacts/mygo-stage3/CurrentMusic.MediaProbe.test.exe '-test.run=^TestWindowsQualityResume$' '-test.v=true'
./windows/artifacts/mygo-stage3/CurrentMusic.MediaProbe.test.exe '-test.run=^TestWindowsMediaFixtures$' '-test.v=true' '-test.timeout=150s'
Remove-Item Env:CURRENTMUSIC_MEDIA_FIXTURE_DIR

$env:CURRENTMUSIC_NATIVE_CAPTURE_DIR = Join-Path $PWD 'windows/artifacts/mygo-stage3/native'
go -C windows/mygo test -mod=readonly -v -count=1 -run '^TestCapturePlaybackPreview$'
Remove-Item Env:CURRENTMUSIC_NATIVE_CAPTURE_DIR

# 后端测试使用 deploy/requirements-auth.txt 和 deploy/requirements-search.txt 的依赖。
$env:PYTHONPATH = "$PWD;$PWD\backend\tests"
python -m unittest backend.tests.test_listen_ms backend.tests.test_search_lyrics backend.tests.test_playback_sources
~~~

Windows 11 24H2 x64 使用合成 MP3、FLAC 与回环 HTTP 执行换档回归。后端 54 项收听、歌词及音源回归通过。收听回归使用临时 SQLite 数据库和模拟网易云绑定回执，覆盖并发幂等开始、播放中增量、断线重试及结束尾段。当前主站已只读验证《春日影 (MyGO!!!!! ver.)》的归一化歌词。生产后端部署和真实绑定账号的网易云回执待验证。构建、日志、SHA-256 和测试数据的原生截图位于 `windows/artifacts/mygo-stage3/`。

MP3、44.1 kHz FLAC、96 kHz FLAC 各完成 20 次 Seek，AAC 完成 2 次。三种 MP3／FLAC 测试的最高 P95 为 858 毫秒，最大位置误差 50 毫秒。MP3 切换至 FLAC 后继续播放，暂停时切回 MP3 保留位置与暂停状态，两个方向均沿用同一播放标识。主站的 `/plays/capabilities` 实测返回 HTTP 404，正式收听同步须等待兼容后端。

## 第四阶段 Windows 桌面集成

- 关闭主窗口将其隐藏到托盘。左键点击 CurrentMusic 托盘图标可恢复窗口，右键菜单提供播放、切歌、桌面歌词和退出。同一 Windows 用户在当前登录会话再次启动程序时，会恢复已有窗口。
- 在「设置 → 桌面集成」或托盘菜单打开桌面歌词。窗口置顶，使用播放页的逐字时间轴。拖动歌词窗口标题可移动它。锁定位置后仍可操作关闭和解锁按钮。启用点击穿透后，可从主窗口设置或托盘菜单解除。应用保存开关及窗口位置。
- 锁屏或休眠时暂时隐藏桌面歌词，解锁或唤醒后按原设置恢复。显示器变化时将歌词窗口限制在可用工作区内。SMTC 和界面命令使用同一 Go 播放控制器。WinRT 使用系统默认音频输出，端点失效后会在系统通知设备恢复时尝试从最后位置重新打开音源，并保留播放或暂停意图。

~~~powershell
./windows/mygo/build.ps1 -Output windows/artifacts/mygo-stage4
go -C windows/mygo vet -mod=readonly ./...
go -C windows/mygo test -mod=readonly -c -o ../artifacts/mygo-stage4/CurrentMusic.MediaProbe.test.exe

$artifact = (Resolve-Path 'windows/artifacts/mygo-stage4').Path
$sdk = Join-Path $env:WindowsSdkDir 'Include/10.0.26100.0/cppwinrt'
cl.exe /nologo /std:c++20 /EHsc /permissive- /O2 /MT "/I$sdk" "/Fo$artifact/SMTCProbe.obj" windows/mygo/media/check_smtc.cpp /link WindowsApp.lib "/OUT:$artifact/CurrentMusic.SMTCProbe.exe"
$env:CURRENTMUSIC_NATIVE_CAPTURE_DIR = Join-Path $artifact 'native'
$env:CURRENTMUSIC_SMTC_PROBE = Join-Path $artifact 'CurrentMusic.SMTCProbe.exe'
& (Join-Path $artifact 'CurrentMusic.MediaProbe.test.exe') '-test.run=^TestNativeDesktopIntegration$' '-test.v=true'
Remove-Item Env:CURRENTMUSIC_NATIVE_CAPTURE_DIR,Env:CURRENTMUSIC_SMTC_PROBE
~~~

运行原生集成测试前，可将 `CURRENTMUSIC_MEDIA_FIXTURE_DIR` 指向合成样本目录，以便系统媒体命令驱动真实 WinRT 回环播放。省略该变量时，测试使用真实 Windows 媒体会话和模拟引擎验证 Go 命令分发。可运行构建、测试日志、SHA-256 和桌面歌词截图位于 `windows/artifacts/mygo-stage4/`。

Windows 11 24H2 x64（26100.9711）原生测试通过。第二个进程成功恢复隐藏的主窗口。歌词的置顶、移动锁定和点击穿透通过原生窗口状态检查，模拟的锁屏、休眠和音频输出变化验证了歌词显隐与暂停位置恢复。Windows 媒体会话管理器枚举到一个测试会话，系统播放及暂停命令到达 Go 控制器，清除后枚举为零。

重新连上远程音频后，真实 WinRT 回环播放补测通过。应用隐藏时，系统媒体命令能控制实际播放和暂停，退出后媒体会话清除。日志见 `windows/artifacts/mygo-stage4/desktop-winrt-acceptance.txt`。物理锁屏、休眠、蓝牙切换、混合 DPI 和目标 25H2 环境仍待验收。

## 第五阶段 MSI 与发布验收

MyGo 使用独立的 WiX 4.0.6 x64 打包入口，安装至 `%ProgramFiles%\CurrentMusic`，沿用 WinUI 1.0.0 的升级标识和开始菜单入口。安装包最低允许 Windows 11 24H2，首发验收目标为 Windows 11 25H2 x64。旧版卸载和新版安装位于同一事务中。安装包同时包含项目许可证和运行时依赖声明。

从配置好 Go、MSVC 和 Windows SDK 的 x64 Developer PowerShell 7.4 或更新版本执行。安装 WiX 4.0.6 与同版本的 UI 扩展。以下命令生成带临时 Authenticode 签名的本地验收包和 SHA-256 文件。

~~~powershell
dotnet tool install --global wix --version 4.0.6
wix extension add -g WixToolset.UI.wixext/4.0.6
$wix = (Get-Command wix).Source
$signTool = (Get-Command signtool.exe).Source
$payload = 'windows/artifacts/mygo-stage5-build'
$out = 'windows/artifacts/mygo-stage5'

./windows/mygo/build.ps1 -Output $payload
./windows/mygo/installer/build.ps1 -Payload $payload -Wix $wix -Output $out -SignTool $signTool -TestSign

$msi = Join-Path $out 'CurrentMusic-Windows-2.0.0-x64-test-signed.msi'
$legacy = Join-Path $env:USERPROFILE 'Downloads/CurrentMusic-For-Windows-1.0.0-x64.msi'
# 在提权的 x64 PowerShell 中执行。
./windows/mygo/installer/test-install.ps1 -Installer $msi -LegacyInstaller $legacy -Wix $wix -Isolated
Get-FileHash -Algorithm SHA256 -LiteralPath $msi
~~~

隔离验收在 MSI 副本中更换包、产品、升级族和组件标识以及安装目录与快捷方式，保留旧版文件和原包中的安装事务。日志位于 `verification/` 内对应的测试运行目录。干净验收机可省略 `-Isolated`，用原始产品标识执行同一套用例，并确认安装后的原生窗口启动。带临时签名的 MSI、EXE 和 DLL 使用自签根，Windows 仍报告根证书不受信任。

连续播放测试使用本机默认音频端点和 WinRT 媒体桥。测试交替播放一分钟 MP3 与 FLAC，每分钟记录 MediaPlayer 实际推进的时间。运行前保持测试会话和音频端点有效。

~~~powershell
./windows/mygo/make-fixtures.ps1
go -C windows/mygo test -mod=readonly -c -o ../artifacts/mygo-stage5-build/CurrentMusic.MediaProbe.test.exe
$env:CURRENTMUSIC_MEDIA_FIXTURE_DIR = (Resolve-Path 'windows/artifacts/mygo-fixtures').Path
$env:CURRENTMUSIC_MEDIA_ENDURANCE = '2h'
& (Join-Path $payload 'CurrentMusic.MediaProbe.test.exe') '-test.run=^TestWindowsMediaEndurance$' '-test.v=true' '-test.timeout=2h12m'
Remove-Item Env:CURRENTMUSIC_MEDIA_FIXTURE_DIR,Env:CURRENTMUSIC_MEDIA_ENDURANCE
~~~

Windows 11 24H2 x64（26100.9711）完成构建、Go 测试、`go vet` 和凭据扫描。隔离 MSI 通过全新安装、真实旧版 1.0.0 升级、故障回滚、缺失媒体桥修复、旧版及 MyGo 降级阻止和卸载。已核对原始测试签名 MSI 的 SHA-256 和提取后的四个安装文件。主会话已有运行中的 CurrentMusic，安装回归验证了安装目录中的媒体桥加载，已安装 EXE 的独立启动留待干净验收机。耐久测试完成 82 首样本，累计实际播放 1 小时 22 分 32 秒。RDP 断开后系统失去音频端点，播放以 `0xC00D4E86` 失败，两小时门槛待重跑。

正式签名在授权的签名环境中执行。把签名证书指纹和 HTTPS RFC 3161 时间戳服务地址分别提供给 `-CertificateThumbprint` 和 `-TimestampUrl`。本机证书库存有证书时，可用 `-MachineCertificateStore` 选择计算机存储。构建脚本只有在 MSI、EXE、DLL 均通过可信链与时间戳检查后才生成正式命名的包。[Microsoft SignTool](https://learn.microsoft.com/windows/win32/seccrypto/signtool)

本机缺少受信任的发布证书。正式签名、Windows 11 25H2 实机验证、两小时播放和前序阶段尚未完成的必验项通过后，才能创建独立的 Windows Release，例如 `windows-v2.0.0`，上传正式 MSI 及其 SHA-256。
