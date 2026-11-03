# Web 加载、骨架屏与页面过渡

入口启动等待从可见文字改为 Material 3 Expressive 风格的七形态连续变换。
MDUI 当前依赖为 2.1.5，官方组件未提供多形态 LoadingIndicator；这里是本地 SVG/CSS 实现，
不是 MDUI 原生组件。设计参考 [Material 3 Loading indicator](https://m3.material.io/components/loading-indicator/overview)
与 [Google Android 实现的形态序列](https://github.com/material-components/material-components-android/blob/master/lib/java/com/google/android/material/loadingindicator/LoadingIndicatorDrawingDelegate.java)。

## 启动与兼容性

- `web/assets/loading-indicator.svg` 使用相同控制点数量的七种路径近似形态与 CSS 变换，
  形态样式位于 `web/src/loading-indicator.css`，构建时与 SVG 一起内联到 `index.html`，
  并由 `loading.js` 提供给页面、面板和下拉刷新。不依赖字体或远程动画服务。
- 不使用 SVG SMIL 时间线：主脚本阻塞文档加载时 SMIL 可能尚未开始，启动动画必须在此时也能运行。
- 不支持 CSS 路径变换的旧内核会保留可见图形和旋转；开启“减少动态效果”时显示静态图形。
- 保留 `role=status` 和读屏标签，默认无可见加载文字。按本地保存的明暗主题初始化背景，
  打开、浏览器刷新时至少完整展示一轮（1.1375 秒），即使 App 已初始化也等待该轮结束再淡出遮罩；脚本加载失败、执行失败和 9 秒超时的诊断与重试入口保持可用。

## 加载动画配色

七形态动画采用 [MDUI 原生彩色圆形加载器](https://www.mdui.org/docs/progress) 的固定四色：
蓝 `#42A5F5` → 红 `#F44336` → 黄 `#FDD835` → 绿 `#4CAF50` → 蓝，
颜色与形态在同一轮 1.1375 秒内渐变。色值与顺序参照
[MDUI 1.0.2 官方样式](https://github.com/zdhxiong/mdui/blob/v1.0.2/dist/css/mdui.css)。
本地七形态组件沿用此配色，不引入 MDUI 1 运行库。

动画图形不读取 `--cm-primary`、Material 动态主题色或封面提取色；更换配色、封面、皮肤及明暗主题，
都保留这套四色。启动内联动画、页面加载、面板及下拉刷新使用同一份样式。
“减少动态效果”下仍显示固定蓝色静态形态，不进行色彩闪变。

## 页面过渡

`page-motion.js` 统一包裹路由表中的所有页面：旧页 100ms 退场、新页 240–280ms 进场，
返回导航使用反向位移。骨架屏替换为内容时以 220ms 淡入；不叠加逐个列表行动画。

连续导航会取消前一个动画；旧请求完成不会重置新页面的滚动位置。进入页面时先重置滚动，
避免等待接口期间滚动被接口完成打断。路由异常以纯文本展示。

不依赖旧 WebView 缺失的 `Animation.finished`；动画接口不可用时直接更新页面。
“减少动态效果”下不创建页面位移或淡入动画，同时停止骨架微光。

## 完整轮次与无骨架屏页面

- 启动动画的开始时刻由首页内联脚本记录，主脚本到达前已经播放的时间会计入一轮，
  不因初始化完成而重新计时。若主脚本加载较慢，初始化后在下一个完整轮次边界收起。
- `loading.js` 优先使用 CSS `animationiteration` 判断整组结束，同时为旧内核和减少动态效果提供计时回退。
  启用“减少动态效果”时显示相同时长的静态形态。
- 所有无骨架屏的应用路由（包括即时生成的设置、协议、表单页）使用共享七形态加载层。
  内容请求与动画并行；请求就绪后在完整轮次边界显示内容。已有骨架屏的页面保留骨架，
  不再叠加页面加载层。首次打开由启动动画覆盖，不连续播放第二组页面动画。
- 页面、标签和弹窗后续插入的无确定进度加载器也使用相同 SVG；带数值的原生进度条保留。
- 下拉松手触发刷新时，从第一形态重新播放，刷新即刻成功或失败也至少展示一整轮；慢请求在后续
  完整轮次边界结束。请求卡住时刷新指示器最多等待约三轮后择边界收起，页面请求本身不被终止。
  用户主动切页可取消旧页和旧刷新指示器，避免遮挡新页。

## 骨架屏

保留现有首页、列表、搜索、账户等骨架屏，并为专辑、歌手、歌单、电台、歌曲分享、
公开用户主页、MV/视频详情与列表、房间、用户广场、音乐资产、歌词本、曲风分区、
发现推荐与帖子增加相应占位布局。详情页预留封面、标题、操作区及列表；视频预留 16:9 画面；
用户与帖子预留头像和内容块。占位没有交互，不填充虚构标题或数据。

新增及改造的页面骨架提供加载语义和 `aria-busy`；内容或错误状态会替换整个占位节点。
颜色使用实际 MDUI RGB 令牌，并为旧浏览器保留微光和尺寸回退。

## 验证

- `python3 tools/check-js-refs.py`
- `cd web && npm run build`
- `CM_PLAYWRIGHT_MODULE=/path/to/playwright CM_CHROMIUM_EXECUTABLE=/path/to/chrome node tools/test-page-motion.cjs`
- `CM_PLAYWRIGHT_MODULE=/path/to/playwright CM_CHROMIUM_EXECUTABLE=/path/to/chrome node tools/test-loading-cycle.cjs`

浏览器测试包含脚本未下载时的形态变换、减少动态效果、启动诊断、无 `Animation.finished`、
无动画 API、连续导航、过期请求、滚动位置，以及桌面/手机的详情骨架及内容替换。

完整轮次测试覆盖打开、浏览器刷新、无骨架路由、骨架排除、快/慢/失败下拉刷新、主动切页取消及动态进度控件替换。
