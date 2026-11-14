# CurrentMusic 官方网站

单页官网，介绍项目定位、展示各客户端与入口、说明项目简介、提供联系方式与
GitHub 仓库链接，并引导用户下载、访问 Web 端或接入 API。

视觉为「深色流光 Aurora」设计语言：深空底色 + 极光渐变光晕 + 玻璃拟态卡片。
组件层仍基于 MDUI 2（通过重映射其浅色/深色调色板令牌接入 Aurora 色板），
支持浅色（日出色调）与深色主题、移动端优先的响应式布局与基本可访问性。

## 目录结构

```
site/
├── index.html          # 页面主体（单页，全部区块与文案）
├── styles.css          # 站点样式（颜色/圆角/阴影/动效均取自 MDUI 设计令牌）
├── app.js              # 交互：主题、抽屉导航、复制、平滑滚动、滚动定位、入场动画
├── engine/             # 流声引擎独立官网（静态 HTML 和 CSS）
├── assets/
│   ├── favicon.svg     # 站点图标
│   ├── og-cover.svg    # 社交分享封面源文件（矢量）
│   └── og-cover.jpg    # 社交分享封面（1200×630，由 SVG 渲染，平台兼容性更好）
├── tools/
│   ├── serve.mjs       # 零依赖静态服务（本地预览 / 随机端口公网直连）
│   ├── sync.mjs        # 把 data/www 同步到线上域名根目录
│   ├── verify.mjs      # 无头浏览器验收（20 项，需本机 Chrome/CDP）
│   └── overflow.mjs    # 响应式横向溢出定位（排查用）
├── build.mjs           # 构建脚本：复制依赖 + 改写资源路径 + 写指纹 + 校验内容
└── package.json        # 仅声明依赖；node_modules 复用 ../web/node_modules
```

构建产物 `../data/www/`：

```
data/www/
├── home/index.html     # 首页（对外 URL：/）
├── home/engine/        # 流声引擎官网（对外 URL：/home/engine/）
└── home/**             # 资源（对外 URL：/home/...）
```

## 构建

```bash
cd site
node build.mjs              # 输出到 ../data/www（默认）
node build.mjs /tmp/site    # 输出到指定目录
```

构建脚本会：

1. 把 MDUI 2.1.5 与 Material Icons 从 `node_modules` 复制到输出目录的 `home/vendor/`，
   **不依赖任何 CDN**，离线 / 内网环境可直接打开；
2. 把页面里的资源引用改写成 `/home/...` 命名空间（见下），并给 `styles.css`、`app.js`
   写入内容指纹（`?v=<hash>`），避免 CDN 长期强缓存导致“新 HTML + 旧 CSS/JS”混搭；
3. 校验页面内容与链接：关键文案是否齐全、本地资源是否存在、
   外部链接是否都带 `target="_blank" rel="noopener"`、
   **是否出现了未提供的 / 臆测的仓库地址**、
   **指向本站自身的地址是否真有对应文件**、**是否残留“待补充”等占位符**。
   任一项不通过即构建失败。

## 资源命名空间 /home/

官网对外是**根路径** `https://music.20110208.xyz/`，但资源不能占用
`/styles.css`、`/assets/`、`/vendor/` 这类通用路径 —— 该域名下这些路径
归兜底反代与其他页面。因此构建时会把资源引用统一改写成 `/home/` 前缀：

```
https://music.20110208.xyz/            → 首页（nginx location = /）
https://music.20110208.xyz/home/**     → 站点资源（css/js/字体/封面）
```

线上 nginx（`/www/server/panel/vhost/nginx/music.20110208.xyz.conf`）里对应两个 location：

```nginx
location ^~ /home/ {
  root /www/wwwroot/music.20110208.xyz;
  add_header Cache-Control "no-cache";
}
location = / {
  root /www/wwwroot/music.20110208.xyz/home;
  try_files /index.html =404;
  add_header Cache-Control "no-cache";
}
```

> **两个踩过的坑**（改这段配置前务必先读）：
> 1. `try_files` 里写 `/index.html`（相对 server root）会触发**内部重定向**，
>    重新匹配 location 后落到下方 `^~ /` 兜底反代，首页会永远返回旧页面。
>    一定要用**根内相对路径**，并让 `root` 指向文件所在目录。
> 2. `root` 指向 `home/` 时用 `index index.html` 会因“目录索引被禁用”而 **403**。

## 部署

| 路径 | 内容 |
| --- | --- |
| `/` | 本官网（产物 `data/www`，线上 `/www/wwwroot/music.20110208.xyz/home/`） |
| `/app` | CurrentMusic 流声屿 Web 播放器（`data/app`） |
| `/home/engine/` | 流声引擎官网，与主站共用 `/home/` 的静态部署 |
| `/station` | CurrentStation 控制台（`backend/station.html`，反代后端 3010） |
| `/developer`、`/ui-preview/` | 其他既有页面，官网不接管 |
| `/status/` | 服务状态页（Gatus，见 `deploy/gatus/`；页脚友情链接指向它） |

```bash
cd site
node build.mjs        # 构建 → data/www
node tools/sync.mjs   # 同步到 /www/wwwroot/music.20110208.xyz/home/
                      # （可用 ROOT=... 覆盖目标；会自动 chown www:www）
```

### 本地预览

```bash
cd site
node tools/serve.mjs 39517    # 根目录 data/www，/ 映射到 home/index.html
node tools/serve.mjs          # 端口传 0 由系统随机分配
```

该服务零依赖、绑定 `0.0.0.0`、只提供产物内文件并拒绝目录穿越。
若要从公网直连（不经 nginx），注意本机 ufw 默认拒绝入站、只放行白名单端口，
其中 `39000:40000/tcp` 是整段放行的，在该区间内选端口即可；
区间外需先 `ufw allow <端口>/tcp`。


## 验收

需要本机有可用的 Chromium（本项目使用 Playwright 自带的 headless shell）：

```bash
# 1. 起一个静态服务（也可以直接对线上域名跑验收）
cd site && node tools/serve.mjs 8899 &

# 2. 起无头 Chrome 并暴露调试端口
/root/.cache/ms-playwright/chromium_headless_shell-*/chrome-linux/headless_shell \
  --headless --no-sandbox --remote-debugging-port=9333 about:blank &

# 3. 跑验收（本地）
cd site
WS=$(curl -s http://127.0.0.1:9333/json/list | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8'))[0].webSocketDebuggerUrl")
CDP_WS="$WS" SITE_URL=http://127.0.0.1:8899/ node tools/verify.mjs

# 或对线上域名验收
CDP_WS="$WS" SITE_URL=https://music.20110208.xyz/ node tools/verify.mjs
```

验收覆盖：MDUI 组件注册与渲染、图标连字是否合成为字形、主题切换与持久化、
外部链接属性、长链接不被截断、移动端抽屉开合、桌面/移动/320px 三档无横向溢出、
控制台无未捕获异常。

## 内容维护须知

- **两处群号与加群链接、CurrentMusicX Releases 链接**必须完整保留，不得截断；
  长链接以 `<code>` 全文展示并提供复制按钮。
- **仓库地址来源（已核实，勿凭印象改）**：
  - 主仓库 / 概念版客户端：`backrooms-yrc/CurrentMusic`（公共仓库，Web 客户端与公开代码）。
    依据：[`README.md`](../README.md) 「相关仓库」小节，以及 App 内更新检查
    [`web/src/update.js`](../web/src/update.js) 里的 `GH_REPO = 'backrooms-yrc/CurrentMusic'`；
    `data/releases/latest.json` 的 `githubUrl` 同样指向该仓库的 Releases。
  - 完整源码：`backrooms-yrc/CurrentMusic`（后端、客户端、部署模板与文档）。
  - 概念版客户端**没有独立仓库**：它就是开发者本人基于 Android WebView 的客户端，
    与主仓库同源，安装包在主仓库 Releases 发布。因此“概念版仓库”指向主仓库 Releases。
  - 概念版的两个下载源取自后端 `/version/latest`：
    服务器源 `https://music.20110208.xyz/cm/download/latest`（302 到最新 APK）、
    GitHub Releases `https://github.com/backrooms-yrc/CurrentMusic/releases`。
  - **CurrentStation 没有仓库**：通行证与控制台不单独开源，随主仓库一同分发。
    页面上不单列条目，只用一句说明交代这一事实（不再写“待补充”）。
    `build.mjs` 会做两重防护：拦截臆测的 GitHub 地址（白名单精确匹配，
    且只允许 `music.20110208.xyz` / `qun.qq.com` 带子路径），
    并禁止页面出现“待补充 / TODO / TBD / 占位”等占位符。
- **导航栏与页脚的 GitHub 落点必须指向本项目主仓库**
  （`https://github.com/backrooms-yrc/CurrentMusic`），不是 CurrentMusicX。
  导航项用内联 SVG 画 GitHub 标记：内置图标字体（Material Icons Outlined，
  2182 个字形）里**没有** GitHub logo，只能用 CSS `mask` + `currentColor`，
  这样能自动跟随文字颜色，浅色/深色主题无需各维护一份。
  图标类名 `.gh-ic`，实现在 `styles.css` 的 `--gh-mask` 变量里。
- **`canonical` / `og:url` / `og:image` 必须指向本站真实地址**。当前写的是部署地址
  `http://45.207.204.178:39517/`；`app.js` 的 `initSelfUrl()` 会在运行时按实际访问地址
  改写这三个值，所以换域名后页面自洽，但**静态 HTML 里的兜底值仍应在迁移时手动更新**
  （爬虫不执行 JS，读的是静态值）。
- 社交分享封面用 `assets/og-cover.jpg`（1200×630，由 `og-cover.svg` 用
  `rsvg-convert` 渲染而来）。不用 SVG 是因为多数社交平台不接受 SVG 作为 `og:image`。
  改封面流程：改 `og-cover.svg` → 重新渲染 JPEG：

  ```bash
  cd site/assets
  rsvg-convert -w 1200 -h 630 -o /tmp/og.png og-cover.svg
  convert /tmp/og.png -background white -alpha remove -alpha off -quality 90 -strip og-cover.jpg
  ```
- 概念版的兼容性提示（显示异常、版式错乱、性能降低）不可删除。
- 页脚免责声明保留：CurrentMusic 为第三方开源项目，与网易云音乐官方无隶属关系。

## 已知取舍

- `app.js` 与 `mdui.esm.js` 均为原生 ESM，因此页面需要 HTTP(S) 托管，
  用 `file://` 直接打开会被浏览器的模块/CORS 策略拦截。
- 图标字体体积约 152 KB，与站点其他资源一样由浏览器长期缓存；
  若需进一步压缩，可只保留用到的字形子集（当前页面使用 40 个图标）。
- 页面内所有外链都应定期复测。快速复测（提取页面全部地址并逐个请求）：

  ```bash
  cd data/www
  node -e "const h=require('fs').readFileSync('index.html','utf8');
    console.log([...new Set([...h.matchAll(/https?:\/\/[^\s\"'<>)]+/g)].map(m=>m[0]))].join('\n'))" \
  | while read -r u; do printf '%s  %s\n' "$(curl -s -o /dev/null -m 25 -L -w '%{http_code}' "$u")" "$u"; done
  ```

