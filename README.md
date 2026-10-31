# CurrentMusic

![CurrentMusic](assets/brand/currentmusic-icon.png)

当前版本 **v1.28.81（173）**。本仓库提供 CurrentMusic Web 前端与 Android WebView 壳代码。
后端服务、部署配置、签名密钥与运行数据不包含在此仓库。

- [下载安装包](https://github.com/backrooms-yrc/CurrentMusic/releases/latest)
- [Web 播放器](https://music.20110208.xyz/app/)
- [API 文档](https://music.20110208.xyz/api-docs/)
- [主站与 CDN 线路测速](https://music.20110208.xyz/app/auto)
- [更新日志](CHANGELOG.md)

## 构建

需要 Node.js、JDK 和 Android SDK（platforms/android-34、build-tools/34.0.0）。

```bash
npm --prefix web ci
export ANDROID_HOME=/path/to/android-sdk
VER_NAME=1.28.81 VER_CODE=173 bash build.sh
```

产物在 `dist/`。首次构建会创建本地签名密钥；自行签名的安装包不能覆盖官方签名版本。
不要提交 `.jks`、环境变量文件或用户数据。Web 静态资源生成于 `app/src/main/assets/www/`。

本版统一使用浅鼠尾草绿与深墨绿「声流 C＋播放键」图标，并同步新版文档入口及播放器更新。
Android 最低版本为 7.0（API 24）。许可见 [LICENSE](LICENSE)。
