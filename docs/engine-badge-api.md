# 流声引擎署名徽章

在网站页脚或项目 README 中引用徽章，点击后可打开流声引擎官网。

[![由 流声引擎 强力驱动](https://music.20110208.xyz/cm/badges/powered-by.svg?v=3)](https://music.20110208.xyz/home/engine/) [![Powered by CurrentMusic Engine](https://music.20110208.xyz/cm/badges/powered-by.svg?lang=en&v=2)](https://music.20110208.xyz/home/engine/)

## 一行嵌入

在 GitHub README 等 Markdown 文档中粘贴这一行。

```markdown
[![由 流声引擎 强力驱动](https://music.20110208.xyz/cm/badges/powered-by.svg?v=3)](https://music.20110208.xyz/home/engine/)
```

在 HTML 页面中粘贴这一行。示例使用英文徽章。

```html
<a href="https://music.20110208.xyz/home/engine/"><img src="https://music.20110208.xyz/cm/badges/powered-by.svg?lang=en&amp;v=2" alt="Powered by CurrentMusic Engine" width="242" height="28"></a>
```

中文版的尺寸为 144 × 28，英文版为 242 × 28。切换语言时可以同时调整替代文本和 `width`，也可以省略尺寸，由 SVG 提供原始宽高。示例中的 `v` 用来刷新旧版图片缓存。

## API

`GET /cm/badges/powered-by.svg` 公开可用，无需登录，支持跨域引用。

| 查询参数 | 取值 | 默认值 |
| --- | --- | --- |
| `lang` | `zh-CN` 或 `en` | `zh-CN` |

成功返回 HTTP 200，正文类型为 `image/svg+xml`。源站声明 1 小时的公共缓存，CDN 可按自身策略调整有效期。`HEAD` 可读取相同的响应头。`lang` 取值无效时返回 HTTP 400。
