# CurrentMusic API 文档

面向客户端开发者的接口手册。这里集中说明自建账户、音乐播放、歌单、社区、一起听、AI、通行证与网易云代理的接入方式。

## 从哪里开始

1. 阅读[快速开始](quickstart.md)，完成首次公开请求与账户登录。
2. 阅读[认证、错误与请求约定](conventions.md)，区分 CurrentMusic 会话与通行证令牌。
3. 在[接口完整索引](endpoints.md)或左侧分类中找到接口。搜索框支持接口路径、参数与关键词。
4. 接入歌词、通行证、私人漫游或一起听时，优先阅读对应的完整专题。

## 服务地址

| 线路 | API 基址 | Web 客户端 |
| --- | --- | --- |
| 主站 | `https://music.20110208.xyz/cm` | [打开主站](https://music.20110208.xyz/app/) |
| CTCEHS | `https://music.ctcehs.com/cm` | [打开镜像](https://music.ctcehs.com/app/) |
| Geekertao | `https://currentmusic.geekertao.com/cm` | [打开镜像](https://currentmusic.geekertao.com/app/) |
| Bileizhen | `https://cm.bileizhen.top/cm` | [打开镜像](https://cm.bileizhen.top/app/) |

通过[线路测速页](/app/auto)选择入口。浏览器与服务端的测速口径不同；某个 CDN 端口可达不表示 API 一定正常。

## 文档如何保证与实现对应

自有接口索引由当前后端路由提取，按 HTTP 方法分别列出实际读取的字段、直接返回结构与业务校验。复杂协议另附可阅读的专题与接入示例。网易云侧按本项目网关登记表列出，每项标明 T0～T3 权限、缓存时间、专用路由优先规则，并附已部署上游版本的参数说明。

> 文档中的“请求模板”需要填写业务参数；“返回结构中的实现表达式”不是伪造的成功响应。上游原始示例中的 Cookie、裸路径、写入方式必须按本站统一请求约定调整。对于尚未匹配到上游独立说明的接口，会明确标记其资料来源。

## 常用场景

- 搜索与播放：搜索 → 歌曲详情 → 登录后解析音源 → 获取歌词。
- 账号接入：注册/登录 → Bearer 会话 → 资料与设备管理。
- 同步网易云：CurrentMusic 登录 → 手机/二维码绑定 → 同步歌单或调用 T1/T2 接口。
- 第三方产品登录：[通行证接入](guide-passport-api.md)，使用授权码 + PKCE。
- 实时能力：[聊天 AI](guide-currentmusic-ai.md)、[一起听](guide-rooms-design.md)。
- 项目署名：[一行代码嵌入流声引擎徽章](guide-engine-badge-api.md)。

## 实用链接

[开发者平台](/developer) · [账户控制台](/station) · [机器可读接口目录](/cm/station/api-catalog) · [本手册目录数据](manifest.json) · [来源与许可](about.md)
