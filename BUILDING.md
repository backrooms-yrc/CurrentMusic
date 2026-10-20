# 从源码构建

[← 返回 README](README.md)

## 环境准备

- JDK 17 及以上，Java / Kotlin 编译目标为 17。
- Android SDK Platform 37.0、Build Tools 35.0.0。
- 配置 `ANDROID_HOME`，或在项目根目录创建不入库的 `local.properties`：

```properties
sdk.dir=C\:/Users/your-name/AppData/Local/Android/Sdk
```

```bash
git clone https://github.com/bileizhen/CurrentMusicX.git
cd CurrentMusicX
```

## 构建与检查

Windows / PowerShell：

```powershell
.\gradlew.bat :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

Linux / macOS：

```bash
chmod +x gradlew
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

Debug APK 输出到 `app/build/outputs/apk/debug/app-debug.apk`。Windows 中文路径遇到构建问题时，可使用 `subst` 将项目目录映射到未占用的盘符后构建。

## 设备测试

连接 Android 设备或启动模拟器后，使用独立测试包，避免与日常安装冲突：

```powershell
.\gradlew.bat -PisolatedDebug=true :app:assembleDebug :app:connectedDebugAndroidTest
```

独立 Debug 包名为 `com.bileizhen.currentmusic.verification`，与正式包数据隔离。测试可能需要登录、网络、系统权限或特定素材，请按对应测试要求准备；构建或单元测试通过不代表真实接口与界面已经验证。

## 正式包与签名

```powershell
.\gradlew.bat :app:assembleRelease
```

签名配置从项目根目录未入库的 `keystore.properties` 读取，字段为 `storeFile`、`storePassword`、`keyAlias`、`keyPassword`。密钥和配置仅保存在本机或受控 CI 中。未配置签名时生成未签名 Release 包。

自行签名与官方包的签名不同时，不能覆盖安装。版本号、更新记录和发布说明应在功能提交之后单独提交；调试录屏、验证产物和本机配置不入库。

## 更新下载体验

仅在独立 Debug 构建中启用：

```powershell
.\gradlew.bat -PisolatedDebug=true -PupdateDownloadExperience=true :app:assembleDebug
```

应用显示为「CurrentMusic 下载体验」，版本带 `-alpha.0` 后缀，可验证真实下载、校验、灵动岛进度与主动安装流程。同版本正式发布仍可被检查到，普通构建及 Release 不启用此模式。

当前更新镜像为 `https://music.20110208.xyz/cm/x/download/latest`，构建时不需要镜像密钥；也保留 GitHub 下载源。
