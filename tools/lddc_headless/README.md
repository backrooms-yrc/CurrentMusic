# LDDC headless Qt shim

LDDC 的歌词 API 本身不依赖 GUI，但它的日志/配置模块会导入
`PySide6.QtCore` 的少量类型。这个目录只提供这些类型的最小空实现，
让 LDDC 能在无桌面、无 PySide6 的服务器上作为独立歌词 provider 运行。

这里**不包含任何 LDDC 源码**。LDDC 以 GPL-3.0 单独安装/运行，
详见 `deploy/install-lddc.sh` 与 `THIRD_PARTY_NOTICES.md`。
