# 意见反馈与 CurrentMusicX Issues

CurrentMusic 网页的「设置 → 关于与帮助 → 引导与协议 → 意见反馈」接受问题和建议。用户确认公开后，服务端调用 CurrentMusicAI，再把反馈发布到 [CurrentMusicX Issues](https://github.com/bileizhen/CurrentMusicX/issues)。

反馈复用 CurrentMusicAI 的模型路由，优先使用启用的 z.ai 主模型，失败时使用 DeepSeek。两个模型在反馈任务中均使用 `reasoning_effort: "max"`。模型判断没有可公开发布的反馈时，回执状态为 `rejected`。所有可用模型调用失败（包括无法解析模型响应）时，直接发布脱敏后的原文，用首行生成标题。

## Issue 模板

- 故障用 [报告问题模板](https://github.com/bileizhen/CurrentMusicX/blob/main/.github/ISSUE_TEMPLATE/bug.yml)，标题前缀为 `[Bug]`。字段包含版本、设备、安装来源、模块、复现步骤、实际与预期结果、频率、环境和诊断信息。
- 改进建议用 [功能建议模板](https://github.com/bileizhen/CurrentMusicX/blob/main/.github/ISSUE_TEMPLATE/feature.yml)，标题前缀为 `[Feature]`。字段包含模块、需求与场景、建议方案和补充信息。

AI 从用户提供的信息填写各字段。缺少的必填信息会标为「不清楚」，缺少的可选信息会标为 `_No response_`，无法识别的模块归为「其他」。Bug 模板中的搜索和隐私检查确认框保持未勾选。服务端随创建请求提交模板对应的 `bug` 或 `enhancement` 标签，GitHub 根据发帖身份权限决定是否应用。

服务端对反馈中的常见凭据、联系方式和链接做脱敏。发送给模型和 GitHub 的内容不附带 CurrentMusic 账号资料。反馈接收回执仅存储站内用户 ID、请求标识、时间、状态和 Issue 编号，原始反馈不写入数据库。

## POST /cm/feedback

使用 `Authorization: Bearer <CurrentMusic 会话令牌>`，请求体为 JSON。

```json
{
  "requestId": "7f36287d51474c66957b3f5930604a99",
  "content": "横屏切回竖屏后，歌词仍显示为横屏布局。复现版本 1.2.5。",
  "public": true
}
```

| 字段 | 约定 |
| --- | --- |
| `requestId` | 客户端为每条反馈随机生成的 32 位小写十六进制字符串。重试同一请求时复用该值和原请求体。 |
| `content` | 去除首尾空白后为 8–2000 个字符，建议包含版本、现象和复现步骤。 |
| `public` | 必须为 JSON 布尔值 `true`，客户端先向用户说明 GitHub 公开发布和原文回退。 |

HTTP `202 Accepted` 表示已接收，响应为回执。相同账号以相同 `requestId` 重试时返回已有回执，七天内不会再次创建 Issue。

```json
{"requestId":"7f36287d51474c66957b3f5930604a99","status":"processing"}
```

每个账号同时可处理一条，24 小时内可提交五条。HTTP `400` 表示字段无效，`401` 表示需要登录，`429` 表示账号提交过于频繁，`503` 表示通道未配置或当前处理已满。

## GET /cm/feedback

使用同一 CurrentMusic 账号的 Bearer 令牌，传入 `?requestId=7f36287d51474c66957b3f5930604a99`。建议每 3 秒查询一次，直到进入最终状态。回执保留七天，查询不存在、已过期或其他账号的回执均返回 `404`。

```json
{
  "requestId": "7f36287d51474c66957b3f5930604a99",
  "status": "published",
  "issueNumber": 123,
  "issueUrl": "https://github.com/bileizhen/CurrentMusicX/issues/123"
}
```

| `status` | 含义 |
| --- | --- |
| `processing` | 正在整理反馈。 |
| `publishing` | 正在请求 GitHub 发布。 |
| `published` | 已创建 Issue，响应包含 `issueNumber` 和 `issueUrl`。 |
| `rejected` | 模型未找到可公开发布的问题或建议。 |
| `failed` | 发布失败，或服务在请求 GitHub 前重启，可用新的 `requestId` 重试。 |
| `unconfirmed` | GitHub 创建结果不确定，请先检查 Issues 列表再决定是否重试。 |

## 自托管配置

在后端受保护的环境配置中设置 `CM_FEEDBACK_GITHUB_TOKEN`。凭据须可在 `bileizhen/CurrentMusicX` 创建 Issue，例如具备该仓库 Issues 写权限的细粒度令牌。模型继续使用 [CurrentMusicAI 配置](currentmusic-ai.md)。浏览器和第三方客户端只使用 CurrentMusic 会话令牌。
