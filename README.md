# CurrentMusic for Android

Material Design 3 风格的 Android 音乐应用。**本仓库开源其前端壳**（原生 Java WebView 容器 + MDUI 2 Web 前端全部源码）；**实际分发的 Release 是完整版体验**——App 默认连接作者自建的 **网易云音乐 SVIP 音源服务**，开箱即可免费播放超清母带级音质。

![version](https://img.shields.io/badge/version-1.8.0-6750A4) ![android](https://img.shields.io/badge/Android-7.0%2B-34A853) ![license](https://img.shields.io/badge/license-MIT-4285F4)

> ### 关于「免费听 SVIP 歌曲」
> 网易云的黑胶 SVIP 音质（无损 / Hi-Res / 超清母带）在官方 App 需要付费会员，本 App 通过**服务端音源代理**实现：所有取流请求由服务端读取已登录的 SVIP 账号凭据转发，客户端无需任何会员身份——**匿名打开 App 就能直接播放最高 5085 kbps 的超清母带 FLAC**。
>
> 音源基于开源项目 [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi)（本部署使用其增强分支 [api-enhanced](https://github.com/neteasecloudmusicapi-enhanced)）自建，服务端位于项目作者的服务器上：
>
> - API 仓库：**https://github.com/Binaryify/NeteaseCloudMusicApi**（另有社区增强版 [NeteaseCloudMusicApiEnhanced](https://github.com/neteasecloudmusicapi-enhanced)）
> - 你可以在 App 内「设置 → 服务器地址」指向**自己部署**的同类后端（协议为 REST + JSON，见下文），不再依赖作者的服务器
>
> **合规提示**：音源能力来自上游账号与第三方 API，仅供个人学习研究；请勿用于商业用途或大规模分发，相关政策风险由使用者自行承担。

## 实测能力（2026-09 于本项目部署实测）

### 音质档位（同一首歌《孤勇者》，匿名访问实测）

| 档位 | 格式 | 码率 | 体积 | 说明 |
|---|---|---|---|---|
| 标准 | mp3 | 128 kbps | 3.9 MB | 普通用户默认 |
| 极高 | mp3 | 320 kbps | 9.8 MB | 普通用户上限 |
| **无损** | flac | 908 kbps | 27.7 MB | ⚠️ 官方需黑胶 VIP |
| **Hi-Res 高清臻音** | flac | 1,677 kbps | 51.2 MB | ⚠️ 官方需 SVIP |
| **沉浸环绕声 sky** | flac | 2,056 kbps | 62.7 MB | ⚠️ 官方需 SVIP |
| **臻音全景声 jyeffect** | flac | 2,879 kbps | 87.9 MB | ⚠️ 官方需 SVIP |
| **超清母带 jymaster** | flac | **5,085 kbps** | 155.2 MB | ⚠️ 官方需 SVIP，**自动档默认取此最高档** |

- **默认「自动最高」**：服务端并行探测母带/全景声/环绕声/无损四档，按码率择优返回（实测命中超清母带）
- 每个档位都可在播放页一键切换，并可**按所选档位下载**到本地（DownloadManager + 自定义目录）
- 服务端只缓存"档位名"，不缓存带时效签名的音频直链（链接 20 分钟自动过期）

### 匿名即可用

搜索、歌曲详情、**全档位取流（含 SVIP 母带）**、评论区（读）、歌词（含翻译/罗马音）、每日推荐 30 首、网易云公开歌单/排行榜浏览。

### 登录后的增益

- **站内点赞**（自有云、全站计数）与**网易云红心**双体系
- 自建歌单管理、播放历史
- 「猜你喜欢」（基于点赞歌手的每日推荐增强）
- **扫码绑定自己的网易云账号** → 一键同步全部歌单（实测 31 张歌单 3791 首）、以该账号发表/删除评论、点赞/回复评论、红心歌曲
- 注册送邮箱验证（验证码 5 分钟有效），另有内部账户渠道

### 已知限制（如实告知）

- **少量曲目受版权/地区限制**不可播放（如部分独家版权曲）；服务端出口在海外时限制更多，本项目部署实测**周杰伦等此前受限曲目现已可正常播放**（上游策略变动），但不保证长期
- 无桌面歌词、无 MV 播放、无本地音乐扫描
- 自签名 APK，首次安装需允许未知来源

## 功能一览

- **播放**：队列管理、四模式合一（列表/单曲/顺序/随机）、当前播放列表弹层、MediaSession、**后台保活**（前台服务 + 唤醒锁）
- **歌词**：LRC/YRC/混合格式逐行解析、双语/原文/翻译/罗马音/原文+罗马五模式、字号四档、当前句恒居中、点行跳播
- **账号**：自建注册（邮箱验证码）/登录 + 内部账户渠道、多账号本地切换
- **歌单**：网易云扫码绑定、全量自动同步（4 并发 + 时间预算幂等续传）、正序/倒序/歌名/歌手排序
- **评论区**：热门/最新/楼层回复，点赞、回复、删除自己的评论
- **个性化**：**动态取色**（全局主色随封面自动变化）、6 套预设配色、**沉浸模式**（封面主色流动渐变）、深浅主题
- **体验**：全控件 MD3 涟漪、骨架屏、方向感知转场动画、原生 insets 桥（全面屏/平板沉浸式）、Pad 双栏导航

## 架构

```
┌────────────────────────────────────┐
│ Android 壳（纯 Java，无 androidx）   │  app/          ← 本仓库开源
│  · assets → 伪源 https://cm.local   │
│  · NativeApi HTTP 桥（绕开 CORS）    │
│  · insets / 沉浸式 / 前台保活 / 下载   │
│  └ MDUI 2 SPA（esbuild 单包）        │  web/          ← 本仓库开源
└──────────────┬─────────────────────┘
               │ REST + Bearer token
┌──────────────▼─────────────────────┐
│ CurrentMusic 后端（自建账号/点赞/    │  ← 不在本仓库
│ 歌单/评论 + NCM 音源代理）           │
└──────────────┬─────────────────────┘
               │
    NeteaseCloudMusicApi（SVIP 凭据）   ← https://github.com/Binaryify/NeteaseCloudMusicApi
```

App 内「设置 → 服务器地址」可指向任何实现同一协议的部署；前端源码（`web/src`）是完全独立的 SPA，也可直接托管为网页版。

## 构建

无需 Gradle / AndroidX——`build.sh` 直接走 aapt2 → javac → d8 → zipalign → apksigner：

```bash
# 依赖：JDK 17 + Android SDK（platform-34 / build-tools 34.0.0）+ Node
cd web && npm install && cd ..
./build.sh                              # 产出 dist/CurrentMusic-*.apk（约 320 KB）
VER_NAME=1.8.1 VER_CODE=21 ./build.sh   # 自定义版本号
```

## 下载

APK 见 [Releases](../../releases)（自签名；首次安装允许未知来源即可）。打开 App 默认即连作者服务器，可直接体验全部音质档位。

## License

[MIT](./LICENSE)。前端壳代码可自由使用；**音源服务与上游 API 的使用请遵守对应服务条款**。
