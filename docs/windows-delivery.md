# CurrentMusic for Windows 1.0.0 交付记录

日期：2026-11-01（Asia/Shanghai）。原生 C# / WinUI 3；应用与 MSI 版本均为 1.0.0。功能和操作说明见 [Windows README](../windows/README.md)，五阶段范围见 [开发计划](windows-five-phase-plan.md)。

## 本机安装程序

| 架构 | 完整路径 | 文件大小 |
| --- | --- | --- |
| x64（Intel / AMD） | `/opt/currentmusic/windows/artifacts/installers/CurrentMusic-For-Windows-1.0.0-x64.msi` | 75,686,228 字节 |
| ARM64 | `/opt/currentmusic/windows/artifacts/installers/CurrentMusic-For-Windows-1.0.0-arm64.msi` | 72,917,268 字节 |

SHA-256：

```text
e419d7506a9d0d6a5489942e23b84af7dc5534ec9e2e5da3e885d1cf3828c547  CurrentMusic-For-Windows-1.0.0-x64.msi
d0ea7e73721dbcea2d7ed0ff2ccdf0acc26aca847132d1b1364ae96415598346  CurrentMusic-For-Windows-1.0.0-arm64.msi
```

同目录有 `.msi.sha256` 文件。两份安装包已从私有 CI 下载至以上路径；校验了 GitHub 附件 ZIP 的摘要、MSI 的摘要、复合文档文件头、MSI 产品版本/架构及应用自身 `.pri` 资源索引。安装程序和本地验证日志均已忽略，不作为源码提交；本机文件不随 CI 附件到期而失效。

## 构建与验证证据

源码提交：`f916190e7ecfdd9b4df00e3d1b38de8baf9207e3`。历史私有 CI 41322433938 的 Linux Core、Windows x64、Windows ARM64 三项任务均通过；该运行记录仍保密。迁移后的构建请查看 [公开 Windows 工作流](https://github.com/backrooms-yrc/CurrentMusic/actions/workflows/windows.yml)，本记录不代表新的公开运行已完成。

- 本地 .NET 10.0.403：`dotnet run --project windows/CurrentMusic.Core.Tests -c Release -- --live`，10 组检查通过，含探针、实际公网搜索（30 首）与歌词契约（38 行）。纯逻辑检查覆盖队列、随机历史、歌词边界、会话隔离、两步挑战字段、401 分流、取消与响应大小等。
- Windows x64：发布目录和实际 MSI 安装后的程序均通过 13 项原生检查：窗口加载、账号表单、凭据管理器读写、搜索结果绑定、队列、云端列表、深色主题、偏好持久化、置顶歌词窗、MediaPlayer/SMTC 初始化、原生 MP3/FLAC 解码及设置导航。
- 实际 x64 MSI：安装临时 0.9.0 基线 → 升级 1.0.0 → 原生检查 → 故意失败的 1.0.1 升级回滚 → 确认仍安装 1.0.0 → 阻止 0.9.0 降级 → 修复 → 卸载。临时旧版和失败包只在 CI 构造，没有对外发布，不代表曾发布这些产品版本。
- ARM64：原生程序与 MSI 构建通过；当前 x64 runner 不运行 ARM64 安装验收。

本地原始验证报告：

- `/opt/currentmusic/windows/artifacts/installers/verification/installer-result.json`
- `/opt/currentmusic/windows/artifacts/installers/verification/preinstall-smoke.json`
- `/opt/currentmusic/windows/artifacts/installers/verification/native-smoke.json`

`installer-result.json` 的 install、upgrade、rollback、downgradeBlocked、repair、uninstall、nativeUi 与 success 均为 true。验证目录还保存安装、升级、回滚、降级、修复和卸载的 MSI 日志。

本轮安装启动检查发现并修复了 unpackaged 发布漏带项目 PRI 的问题，项目已显式发布该文件，打包器也会拒绝缺失资源索引的目录。依据：[Windows App SDK issue #6720](https://github.com/microsoft/WindowsAppSDK/issues/6720)。

## 实际交付边界

已经实现后续阶段的账号/搜索/播放/歌词/音乐库/Windows 集成及 MSI 交付代码，并完成上述可执行检查；不能将其描述为原计划所有人工验收门槛均已满足。

- 当前 MSI 未做 Authenticode 签名，没有配置代码签名证书。
- 原生窗口自动检查使用独立模拟 API、临时偏好与独立凭据条目。不会用生产用户会话代替测试账号，不创建生产用户，也没有操作生产歌单。公网只读验证与模拟检查分别记录。
- MP3/FLAC 检查通过 Windows Media Foundation 转换为 PCM，证明原生解码链路可用；不等于实际声卡输出、真实账号音源播放、高采样率/多声道设备、网络切线、长时间连续播放均已实机验收。
- Windows 10/11、ARM64 真机、混合 DPI、屏幕阅读器和长期稳定性矩阵仍需补充；当前提供的是已通过 x64 安装和原生启动自动验证的 1.0.0 安装包。
- 更新采用手动 MSI 升级；不配置未经授权的公开更新源。公开仓库、GitHub Releases、Android 与 X 侧未随本次 Windows 开发发布。
