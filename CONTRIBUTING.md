# 参与 CurrentMusic

完整源码统一在 `backrooms-yrc/CurrentMusic` 维护，默认分支为 `main`。请从最新 main 建分支并提交 PR。历史私有库仅保留非公开历史，不是公开开发的上游。

```bash
git switch -c codex/your-change
# 实现、验证后，用明确的文件清单提交。
git add path/to/changed-file
git commit -m "fix: describe the change"
git push origin codex/your-change
```

## 提交前

- 后端：先安装 `deploy/requirements-auth.txt`，用 `tools/run-tests.sh` 运行相关测试。它强制使用临时数据库和数据目录，禁止用生产库运行测试。
- 前端：`python3 tools/check-js-refs.py`，再执行 `npm --prefix web ci && npm --prefix web run build`；同步提交 `app/src/main/assets/www/` 与生成的比例表。
- 文档/导出：`python3 tools/test-api-docs.py`、`python3 tools/test-open-source.py`。
- 安全边界：`python3 tools/check-open-source.py`。CI 还会用 Gitleaks 扫描当前源码，报告只保留文件位置与规则。
- 接口变化：同步 Markdown 专题、自动目录与在线文档。说明用户可见行为和验证结果。

不要提交 AGENTS.md、本地环境、生产数据、数据库、cookie、令牌、签名密钥或安装包。官方签名密钥不向贡献者分发；本地 Android 构建使用自己的密钥。第三方素材需说明来源与许可。

## 自动检查

普通 PR 以只读仓库权限运行构建、后端测试、文档测试与敏感信息扫描。Windows 源码变化另外触发原生客户端构建与安装验证。AI 审查为可选功能，依赖维护者自行配置的 Actions secret；仓库不会分发服务端凭据。

维护者负责部署与版本发布。普通代码更新不等于 Android 发版，不应为文档或后端准备工作额外创建 APK Release。CurrentMusicX 的代码和版本仍在它自己的仓库独立维护。
