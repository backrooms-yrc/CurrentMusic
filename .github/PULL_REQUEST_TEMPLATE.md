<!-- 开 PR 时请把这个模板填完：评审人主要看「做了什么 / 为什么 / 影响范围」。 -->

## 改动说明

<!-- 用几句话说清楚：做了什么、为什么这么做；涉及行为变更的请说明影响范围与兼容性 -->

## 改动类型

- [ ] 🐛 Bug 修复（不改变现有功能行为）
- [ ] ✨ 新功能
- [ ] 💥 破坏性变更（行为/接口不兼容，需在说明中标注迁移方式）
- [ ] 📝 文档更新
- [ ] 🔧 重构 / 代码风格
- [ ] ✅ 测试补充
- [ ] 🎨 UI 皮肤 / 样式（**仅新增皮肤**，不得改动默认外观）

## 影响范围

<!-- 勾选并补充说明受影响的部分 -->
- [ ] 后端（`backend/*.py`）
- [ ] 前端（`web/src/*`）
- [ ] 安卓端（`app/src/main/java/*`、`AndroidManifest.xml`）
- [ ] 构建脚本（`build.sh`、`web/build.mjs`、`publish_release.py`）
- [ ] 挂件素材 / 清单（`decorations/*`）
- [ ] 仅文档

## 自测清单

- [ ] 本地跑过 **后端与脚本检查**：
      `python3 -m py_compile backend/*.py tools/*.py` 且各模块能 `import`
- [ ] 本地跑过 **前端构建**：`cd web && npm ci && node build.mjs`
- [ ] **构建产物已一并提交**（改了 `web/src` 就必须重新构建：`app/src/main/assets/www/*`、`web/src/decor-scales.js`）
- [ ] **默认 UI 未被改动**：新增样式限定在 `html[data-ui-preset="..."]` 作用域内（默认外观的改动属于破坏性变更）
- [ ] 兼容性：未使用目标内核不支持的特性，或已提供降级方案（前端目标 `chrome58`，安卓 8 的出厂 WebView）
- [ ] 无第三方依赖引入（后端坚持 Python 3 标准库；前端新增依赖需在说明中给出理由）
- [ ] 无密钥 / 签名文件 / APK 入库（本仓库有公开镜像）
- [ ] 涉及用户可见行为的改动，已同步更新 `README.md` 变更条目与 `web/src/version.js` 版本号
- [ ] 涉及数据库的改动，迁移方式安全（`PRAGMA table_info` + `ALTER TABLE`，不破坏既有数据）

## 关联 Issue

<!-- 例如：Fixes #3 ；无关联可删除本节 -->
