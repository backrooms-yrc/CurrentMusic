# Bit-perfect 192 kHz / 24-bit 排障

CurrentMusic 的 Bit-perfect 后端使用 Android API 34 的首选混音器接口。普通 AudioTrack、Oboe 和 Direct 后端不因此获得逐位输出认证。

## 已确认的代码问题

旧 `AndroidBitPerfectStream.open` 用 `AudioFormat.equals()` 匹配 HAL 配置。Android 的实现还比较属性标记以及位置/索引声道掩码，不能把对象不等直接解释为 PCM 样本格式不兼容。新匹配保持采样率、PCM 编码、声道数严格相同，仅接纳明确的单声道/双声道规范布局等价表达；多声道布局不推测。创建 AudioTrack 使用 HAL 返回的原始 AudioFormat。

旧错误把“Android 未提供匹配的 Bit-perfect MixerAttributes”描述成“设备未提供”，无法说明是否为查询失败、采样率缺失或编码缺失。AudioDeviceInfo 的采样率、编码数组也不能证明某个联合格式获得 HAL 的 BIT_PERFECT 支持。

补齐设置请求及读回验证、AudioTrack 实际格式、setPreferredDevice 返回值、实际 routedDevice、两秒路由确认超时、设备断开/配置撤销与异常清理。成功状态仅表示 Android API 配置及路由已确认，不代表已用硬件测量逐位透明度。

24-bit 使用 Android `ENCODING_PCM_24BIT_PACKED`（21，3 字节），Media3 1.11.1 的常量映射原本正确。PCM 32-bit integer（22）与 float（4）不是同一格式，禁止互相冒充；不通过重采样解决 192 kHz 请求。

## 如何收集

1. 连接目标 DAC，在音频输出设置中选择它与 Bit-perfect 模式。
2. 播放出错的音源，返回“音频输出”，点击“复制音频诊断”。
3. 或运行 `adb logcat -d -s CurrentMusicAudio:I` 收集统一 TAG 日志。

日志记录系统版本、设备类型和报告的能力、全部 MixerAttributes、源声明格式、请求及实际解码 PCM、首选配置的设置/读回、AudioTrack 初始化、实际格式和路由、最终状态、清理结果。记录限量保留在本次进程内存，不包含歌曲标题、媒体 URI、USB 地址、账号、令牌或 PCM 内容。

主要失败分类：

| 代码 | 含义 |
| --- | --- |
| ANDROID_VERSION | 系统低于 API 34 |
| USB_MISSING / USB_AMBIGUOUS | 目标 USB 未连接或需明确选择 |
| MIXER_QUERY | 系统查询失败，不能当作支持列表为空 |
| NO_BIT_PERFECT_MIXER | Android 没有报告任何 BIT_PERFECT 配置 |
| MIXER_RATE / MIXER_ENCODING / MIXER_CHANNELS | 逐位配置缺少请求的采样率、准确 PCM 编码或声道布局 |
| REQUEST_REJECTED | 系统设置接口明确返回 false |
| PREFERENCE_NOT_RETAINED | 设置返回 true，但配置读回不一致 |
| TRACK_INITIALIZATION / TRACK_FORMAT / DEVICE_PREFERENCE | AudioTrack 初始化、格式或设备请求失败 |
| ROUTE_MISMATCH / ROUTE_UNCONFIRMED | 实际输出去了其他设备，或启动后无法确认 USB 路由 |
| DISCONNECTED / MIXER_REVOKED / WRITE_FAILED | 播放期间设备断开、配置撤销或写入失败 |

若 AudioDeviceInfo 报告 192000，但 BIT_PERFECT 列表仅含 48000，应判断为 Android 没有暴露此 192 kHz 逐位配置；DAC 的硬件能力仍未知。系统默认采样率 48000 也不能作为当前输出采样率。

## 网易云 USB 独占的静态证据

2026-10-27 对官方 9.6.15（versionCode 9006015）APK 进行只读分析，未安装或运行。官方入口 `https://music.163.com/api/android/download/latest` 当日返回 `NeteaseCloudMusic_Music_official_9.6.15.261027102340_32.apk`。

- APK SHA-256：`25df16b292990f5111e20a1a558b046f9f8c4573db702421455601e5f60944fa`。
- 签名证书 SHA-256：`54254d2be09daef48dedc2b4a4f497d153e14ed9d70814fc9c360ee9240827f7`。
- `Lim0/b;->h()V` 请求 `UsbManager.requestPermission`，对应截图中的 Android USB 访问授权框。
- `Lim0/b;->l(UsbDevice)` 调用 `UsbManager.openDevice`、`UsbDeviceConnection.getFileDescriptor()`，将 fd 交给播放器的 `useUSBDevice(int)`，并切换音频设备类型。
- `NCMNativeAudioPlayer.useUSBDevice(int)` 转发到声明为 native 的 `_useUSBDevice(int)`。
- APK 包含 `libncmusbaudio.so`，可见 `libusb_wrap_sys_device`、`libusb_claim_interface`、`libusb_detach_kernel_driver`、`libusb_submit_transfer` 等导入/符号，以及等时传输、反馈端点相关字符串。

这些证据支持其具有原生 USB Host 音频输出路径，区别于 CurrentMusic 的 Android HAL 首选混音器路径。静态证据不能证明某首歌的实际位深/采样率，也不能证明该版本在 NK1 MAX 上运行成功。未复制网易云专有代码。另行实现 USB Audio Class 后端涉及接口占用、描述符解析、时钟/反馈和传输，不属于本次 MixerAttributes 修复。

## 验证边界

本次修改文件（均在 `app/src/` 下，文档除外）：

- `main/java/io/github/currencortex/music/core/media/BitPerfectSession.kt`：可注入的能力选择、状态核验与清理。
- `main/java/io/github/currencortex/music/core/media/BitPerfectStream.kt`：Android 适配、HAL 原格式建轨、路由与设备监听。
- `main/java/io/github/currencortex/music/core/media/BitPerfectAudioSink.kt`：解码 PCM 诊断、写入异常清理。
- `main/java/io/github/currencortex/music/core/media/CurrentMusicAudioDiagnostics.kt`：统一日志、完整能力快照与可复制文本。
- `main/java/io/github/currencortex/music/core/media/DockRenderersFactory.kt`：区分源声明、解码请求和解码器输出。
- `main/java/io/github/currencortex/music/core/media/MusicService.kt`：播放器最终错误状态诊断。
- `main/java/io/github/currencortex/music/feature/settings/AudioOutputScreen.kt`：完整支持配置、复制诊断、准确的断开与默认采样率说明。
- `test/java/io/github/currencortex/music/core/media/BitPerfectSessionTest.kt`：22 项可注入平台测试。
- `androidTest/java/io/github/currencortex/music/BitPerfectAudioTest.kt`：Android 常量/掩码、失败清理、切歌重建、其他后端委派及原有字节保留测试。
- `BIT_PERFECT_DIAGNOSTICS.md`：本文。

2026-10-27 验证：完整 JVM 测试 982 项通过（失败/错误/跳过均为 0）；其中新增能力与生命周期测试 22 项。调试 APK、Android 测试 APK 构建通过。RMX5060（API 36）的独立 `.verification` 包运行 `BitPerfectAudioTest`，9 项通过，未覆盖日常应用、未连接 NK1 MAX。Lint 通过，0 个错误（113 个警告、7 个提示仍保留）。

自动化测试使用可注入的设备、混音器和音轨测试替身；Android 测试补充框架常量、格式等价与 PCM 字节保留验证。这些不替代 NK1 MAX 的真机硬件验证。

尚需在目标 DAC 上验证：全部 BIT_PERFECT 配置、192000/21/双声道是否暴露、设置与读回、实际路由、持续播放、切歌格式变化、拔插恢复，以及硬件实际采样率/逐位透明度。若 HAL 不暴露配置，当前后端应准确停止并报告系统限制。

API 契约：[AudioManager](https://developer.android.com/reference/android/media/AudioManager)、[AudioFormat](https://developer.android.com/reference/android/media/AudioFormat)、[Android 首选混音器属性](https://source.android.com/docs/core/audio/preferred-mixer-attr)。
