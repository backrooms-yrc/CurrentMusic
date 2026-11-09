# CurrentMusic for Windows 2.0 技术验证

MyGo 原生界面与 Windows MediaPlayer 的第一阶段原型。首页、搜索、音乐库、队列和逐字歌词采用演示数据。设置中的测试音源接入真实 Windows 播放引擎。首发验收基线为 Windows 11 25H2 x64。

使用验收 ZIP 时，先解压全部文件，再启动 `CurrentMusic.exe`。其中 `fixtures/` 是 60 秒合成测试信号，每 15 秒改变音高，便于用耳朵核对 Seek 后的位置。`design/` 是六张无窗口渲染快照。

## 构建

固定 Go 1.27.3、MyGo v0.8.3（`5add3817c74b`）、Windows SDK 10.0.26100.0。安装 Visual Studio Build Tools 的 Desktop development with C++ 工作负载，从 x64 Developer PowerShell 执行。

```powershell
./windows/mygo/build.ps1
./windows/artifacts/mygo-preview/CurrentMusic.exe
```

`CurrentMusic.exe` 和 `CurrentMusic.Media.dll` 必须在同一目录。原型包用于验收，应用版本的 MSI 和签名属于阶段 5。Windows N 若缺少系统媒体组件，可在安装 Media Feature Pack 后重试。

本次 Linux 构建产物使用 Go 1.27.3 和 Clang 19／LLD，媒体桥使用 Windows SDK 26100 的 C++/WinRT 头及 Windows 导入库。已核对 EXE、DLL 的 x64 PE 架构和 DLL 的九个 ABI 导出。真机加载与音频输出见下方验收表。

## 设计检查

内容区以 DIP 布局。常规界面用青色和中性色组织导航与列表，播放页仅用封面色给背景染色，逐字行以强调色标记已唱部分。首次原型的取色与歌词使用固定演示数据。浅色、深色、返回、搜索焦点、设置、展开播放器、F11 全屏、队列抽屉和窄窗音量弹层均可从窗口操作。

六张可重复生成的设计快照覆盖 1200 × 760、960 × 540、600 × 320 和浅深主题。快照使用 MyGo 无窗口渲染，Windows 实机仍需单独检查 DirectWrite、IME、DPI 和标题栏。

```powershell
cd windows/mygo
$env:CURRENTMUSIC_DESIGN_DIR = Join-Path $PWD '../artifacts/mygo-design'
go test -count=1 -run TestPrototypeRenders
```

## 真机验收

1. 从 Windows 设置或 `winver` 记录版本、build 与 x64 架构。记录播放设备及 Windows 声音设置中的设备默认格式。用物理扬声器或耳机确认输出。
2. 在 100%、150%、200% 显示缩放下测试窗口调整、贴靠、返回、设置、深浅色和全屏。在搜索框输入中文拼音并选词，确认组合框位置、文本呈现、Tab 焦点及快捷键。检查最小客户区可访问播放栏和内容滚动。
3. 将合成样本放到可信的测试 HTTPS 静态目录。用 `curl.exe -f -sS -D - -o NUL -H "Range: bytes=0-1023" URL` 核对 HTTP 206 与 `Content-Range`。样本覆盖 MP3、44.1 kHz FLAC、24-bit／96 kHz FLAC，以及 AAC/M4A。打开设置，粘贴地址并选择「打开测试音源」。验收每种格式实际有声、暂停、续播和前后 Seek。
4. 每个 MP3 和 FLAC 样本在健康网络下做至少 20 次前后拖动，松手后等待「定位完成」。设置页显示从提交到播放位置再次推进的延迟、引擎报告 Seek 完成时的位置误差，以及本音源累计次数、P95 和最大误差。通过条件为 P95 ≤2,000 ms、最大误差 ≤500 ms。另记未能完成的拖动。暂停状态拖动另行确认仍暂停，随后续播应从目标位置开始。
5. 用可直接密码登录的独立测试账号和实际歌曲 ID 走「登录测试账号并播放」。用标准或极高档验证 MP3，用无损档验证实际返回 FLAC。设置页显示响应格式及可得的音源采样率和位深。账号凭据用于官方 HTTPS API，成功取址后尝试撤销测试会话。报告只保留格式、测量和错误类别。
6. 依次打开两个测试源，再按物理媒体键测试播放／暂停、上一首、下一首。打开 Windows 媒体面板，确认只出现一个 CurrentMusic 会话，系统进度与窗口同步。关闭原型后会话应消失。

### 结果记录模板

| 检查项 | 结果与证据 |
| --- | --- |
| OS build、架构、DPI、IME、贴靠 | 待填写 |
| 物理端点及系统默认混音格式 | 待填写 |
| 合成 HTTPS MP3、两种 FLAC、AAC/M4A | 待填写 |
| 官方 HTTPS MP3／FLAC、音源规格 | 待填写 |
| 每种样本 Seek 延迟 P95 和最大误差 | 待填写 |
| 实体媒体键、系统媒体会话数量与退出 | 待填写 |

通过第一阶段须取得以上真机记录。阶段 2 从通过的原生窗口及音频链路继续实现正式账号和曲库。
