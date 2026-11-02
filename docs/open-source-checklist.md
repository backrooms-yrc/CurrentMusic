# 完整仓库开源清单

本次迁移将后端、自托管模板、Web/Android、Windows、官网与 API 文档的当前源码统一到既有公开库 `backrooms-yrc/CurrentMusic`。项目自有代码沿用公开库 MIT 许可，第三方内容保留各自许可。

## 公开边界

| 公开 | 保密/本机保留 |
| --- | --- |
| backend 代码与测试、CLI、接口专题 | 数据库、用户内容、cookie、环境文件 |
| Web、Android、Windows 源码及可重建资源 | 官方签名密钥、APK/MSI 构建输出 |
| 官网、文档站、部署模板、验证工具 | AGENTS.md、本机智能体会话与运维备份 |
| 自有品牌资源、挂件元数据、依赖许可 | 第三方图片/音乐本体及账号凭据 |

生产站点域名、公开 API 地址与公开加群链接是产品入口；它们不代表配置中的认证秘密。扫描不以隐藏公共地址代替保护真实凭据。

## 合并方式

1. 审查当前受 Git 跟踪的文件，排除本机笔记与运行目录；修正自托管配置、文档构建、许可证说明和 CI。
2. 在临时数据库运行后端测试，验证前端引用/构建、无上游目录的文档构建，以及扫描/导出边界回归。
3. 将工作成果提交并推送到原私有库，保留原始非公开历史。
4. 克隆既有公开 main；运行 `python3 tools/export-open-source.py /path/to/public` 预检，再加 `--apply` 导入允许公开的快照。
5. 审查差异，扫描整个待公开树（包括隐藏文件），核实没有 AGENTS.md、生产数据或签名材料。
6. 以既有公开 main 为唯一父提交提交快照，普通快进推送。保留原公开标签、Releases 与公开专有截图，不引入私有 Git 对象/祖先。
7. 工作区切换为公开 main 历史，原 `.git` 另存仓库外的本机私有备份；更新本机 AGENTS.md 的仓库职责与日常推送流程。

旧 `tools/export-frontend-shell.py` 入口现在转交统一导出器，不能再生成“后端未开源”的首页。`export-backend-oss.py` 仅用于单独的后端分发，不用于替换统一公开库。

## 持续检查

- `python3 tools/check-open-source.py` 默认扫描全部受跟踪文件；`--root PATH --all` 扫描干净导出树，包含隐藏文件。只报告文件、行号与规则，不输出匹配值。
- CI 同时运行 Gitleaks 默认规则；仅对文档占位符和官网公开 QQ 加群链接设置限定路径/规则的例外。
- 所有测试使用临时数据库。环境变量管理 API/SMTP/SMS/LDDC/NCM 凭据。
- `CM_PASSKEY_ORIGINS` 为自托管通行密钥提供显式 HTTPS origin 清单；保留官方部署默认值，拒绝通配符和不合法配置。
- 文档可仅依赖当前仓库生成；指定 `NCM_API_DIR` 时添加外部 MIT 上游资料并记录来源哈希。

## 许可

[LICENSE](../LICENSE) 为 MIT。LDDC 为独立 GPL-3.0-only 服务，不复制其源码；MDUI、Material Icons、QR、文档框架和后端依赖的来源见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。安装可选服务不代表重新许可第三方内容。
