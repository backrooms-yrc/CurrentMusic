# 来源、许可与更新

## 页面与文档框架

本手册采用 Meta 的 [Docusaurus](https://github.com/facebook/docusaurus) **3.10.2**（MIT）和 Classic 主题，提供首页、分组侧栏、右侧目录、代码高亮、深浅色切换及本地搜索。所有构建资源与搜索索引均在本机托管，使用系统字体，不依赖第三方 CDN。

[Docusaurus MIT 许可](/api-docs/licenses/docusaurus-MIT.txt)。本地搜索由 @easyops-cn/docusaurus-search-local 提供，不向外部搜索服务发送查询。

## 接口事实来源

- 自有接口：`backend/cm_server.py` 的实际路由分支，提取字段、直接返回结构、权限检查和显式业务错误。
- 网易云接口：`backend/cm_ncm_registry.py` 登记表和 `docs/api-endpoint-phase-map.csv`。
- 上游参数资料：当前部署的 [NeteaseCloudMusicApiEnhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) 的 `public/docs/home.md`，未附带时仅生成登记信息并标注缺失；缺少独立说明时参考 `module/*.js` 中直接读取的字段；保留 [上游 MIT 许可](licenses/ncm-api-MIT.txt)。
- 专题：仓库内通行证、密码、歌词、AI、房间、分享、私人漫游等文档。

## 阅读边界

参数表由源码提取，`get` 默认、条件必填和业务校验不能混为一谈。复杂响应可能来自独立模块，文档会明确注明；返回字段表达式不冒充真实业务样例。设计参考不是当前接口的额外承诺。网易云原始文档涉及的 Cookie、裸路径和上游状态码必须按本站网关约定解释。

无需用户账号的文档页面不会读取音乐客户端的 token，不提供会触发真实写操作的在线执行按钮。请在自己的开发环境使用文档模板。

## 构建与维护

```bash
cd api-docs
npm ci
npm run build
npm run publish
```

内容生成器 `tools/build-api-docs.py` 默认输出中间 Markdown 到 `api-docs/.generated/raw/`；前端适配后由 Docusaurus 构建到 `api-docs/build/`。发布命令将已构建文件同步到 `data/api-docs/`，Nginx 在 `/api-docs/` 提供服务。旧式 `#/quickstart` 文档链接会跳转到新路径。后端路由或上游版本变动后重新构建，并执行目录覆盖检查。

[下载目录清单](manifest.json) · [CurrentStation 的在线接口目录](/cm/station/api-catalog)

项目完整源码现统一在 [CurrentMusic](https://github.com/backrooms-yrc/CurrentMusic)，自有代码采用 MIT；第三方内容保留原许可。
