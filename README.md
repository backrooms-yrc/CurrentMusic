# CurrentMusic for Android

基于 [MDUI 2](https://www.mdui.org/zh-cn/)（Material Design 3）的 Android 音乐应用——本仓库开源其**前端壳**：原生 Java WebView 容器 + Web 前端全部源码。配合同类后端（自建账号体系 + 网易云音源代理）即可完整运行。

![version](https://img.shields.io/badge/version-1.8.0-6750A4) ![android](https://img.shields.io/badge/Android-7.0%2B-34A853) ![license](https://img.shields.io/badge/license-MIT-4285F4)

## 功能一览

- **播放**：队列管理、四模式合一（列表循环/单曲循环/顺序/随机）、当前播放列表弹层、MediaSession
- **音质**：自动最高 + 7 档手动（标准→超清母带），服务端并行探测选优
- **歌词**：LRC/YRC/混合格式逐行解析、双语/原文/翻译/罗马音/原文+罗马五模式、字号四档、当前句恒居中、点行跳播
- **账号**：自建注册（邮箱验证码）/登录 + 内部账户渠道，多账号切换
- **点赞双体系**：站内喜欢 & 网易云红心（二级菜单选择收录目标）
- **歌单**：网易云扫码绑定、全量歌单自动同步（4 并发 + 时间预算幂等续传）、多种排序
- **评论区**：同步网易云（热门/最新/楼层回复），支持点赞、回复、删除自己
- **个性化**：动态取色（随封面换全局主色）、6 套预设配色、沉浸模式（封面主色流动渐变）、深浅主题
- **体验**：全控件 MD3 涟漪、骨架屏、方向感知转场动画、原生 insets 桥（全面屏适配）、后台播放前台服务保活、歌曲下载（DownloadManager + 音质选择）

## 架构

```
┌────────────────────────────────────┐
│ Android 壳（纯 Java，无 androidx）   │  app/
│  · assets → 伪源 https://cm.local   │
│  · NativeApi HTTP 桥（无 CORS）      │
│  · insets/沉浸式导航栏/前台保活/下载   │
│  └ MDUI 2 SPA（esbuild 单包）        │  web/
└──────────────┬─────────────────────┘
               │ HTTP + Bearer token
        你的 CurrentMusic 后端（本仓库不含）
               │
        NCM 音源（需自行部署，如 NeteaseCloudMusicApi）
```

> 后端协议：REST + JSON（`/auth/*`、`/likes/*`、`/playlists/*`、`/ncm/*` 音源代理、`/ncmbind/*` 绑定与评论互动等），可在 App 内「设置 → 服务器地址」指向你的部署。

## 构建

无需 Gradle/AndroidX——`build.sh` 直接走 aapt2 → javac → d8 → zipalign → apksigner：

```bash
# 依赖：JDK 17 + Android SDK（platform-34 / build-tools 34.0.0）+ Node（构建前端）
cd web && npm install && cd ..
./build.sh                          # 产出 dist/CurrentMusic-*.apk
VER_NAME=1.8.1 VER_CODE=21 ./build.sh   # 自定义版本
```

前端源码在 `web/src`（vanilla JS ES modules），构建产物直接写入 `app/src/main/assets/www`。

## 下载

APK 见 [Releases](../../releases)（自签名，安装需允许未知来源）。

## License

[MIT](./LICENSE)
