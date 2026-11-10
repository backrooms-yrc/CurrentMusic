# CurrentMusic API 文档站源码

基于 Meta Docusaurus 3.10.2（MIT）与 Classic 主题，使用本地中英文搜索；所有资源和索引均本机托管。
依赖版本通过 package-lock.json 锁定。Node 20+。

`cd api-docs && npm ci && npm run build && npm run publish`

页面内容在 pages/；tools/build-api-docs.py 生成 .generated/raw/，prepare-content.cjs 适配文档与侧栏，
Docusaurus 构建到 build/，publish.cjs 发布到 data/api-docs/。原 vendor/index.html/site.css 仅保留
旧生成器格式与历史链接兼容，不再作为线上页面。不要把中间文件、运行数据和 node_modules 提交到仓库。

## 独立构建与上游资料

不要求本机存在特定生产目录。默认从当前后端路由、登记表和仓库专题构建；若仓库旁边存在 ncm-api 源码，会读取其公开文档。可通过 `NCM_API_DIR=/path/to/api-enhanced npm run build` 显式指定。没有上游资料时仍生成完整路由/权限清单，缺失的上游参数说明会如实标注，build-info.json 中 upstreamDocumentationIncluded=false、upstreamDocsSha256=null；有资料时记录其内容哈希。

QQ 音乐接口清单来自后端登记表，可在未部署 QQ Music API 的环境中构建。
