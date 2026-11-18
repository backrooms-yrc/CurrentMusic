# 意见反馈与 CurrentMusicX Issues

CurrentMusic 网页的「设置 → 关于与帮助 → 引导与协议 → 意见反馈」接受问题和建议。用户确认公开后，服务端调用 CurrentMusicAI，再把反馈发布到 [CurrentMusicX Issues](https://github.com/bileizhen/CurrentMusicX/issues)。

反馈复用 CurrentMusicAI 的模型路由，优先使用启用的 z.ai 主模型，失败时使用 DeepSeek。两个模型在反馈任务中均使用 `reasoning_effort: "max"`。模型判断没有可公开发布的反馈时，回执状态为 `rejected`。所有可用模型调用失败（包括无法解析模型响应）时，使用脱敏后的原文和首行标题。带附件的原文回退同样使用 Bug 模板。

## Issue 模板

- 故障用 [报告问题模板](https://github.com/bileizhen/CurrentMusicX/blob/main/.github/ISSUE_TEMPLATE/bug.yml)，标题前缀为 `[Bug]`。字段包含版本、设备、安装来源、模块、复现步骤、实际与预期结果、频率、环境和诊断信息。
- 改进建议用 [功能建议模板](https://github.com/bileizhen/CurrentMusicX/blob/main/.github/ISSUE_TEMPLATE/feature.yml)，标题前缀为 `[Feature]`。字段包含模块、需求与场景、建议方案和补充信息。

AI 从用户提供的信息填写各字段。缺少的必填信息会标为「不清楚」，缺少的可选信息会标为 `_No response_`，无法识别的模块归为「其他」。Bug 模板中的搜索和隐私检查确认框保持未勾选。服务端随创建请求提交模板对应的 `bug` 或 `enhancement` 标签，GitHub 根据发帖身份权限决定是否应用。

服务端对反馈中的常见凭据、联系方式和链接做脱敏。发送给模型和 GitHub 的文字不附带 CurrentMusic 账号资料。数据库存储回执及附件标识、大小、校验摘要和到期时间，原始反馈文字不写入数据库。

## POST /cm/feedback

使用 `Authorization: Bearer <CurrentMusic 会话令牌>`。仅提交文字时，使用 `application/json`。

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

### Bug 反馈随附诊断日志

用户同意把诊断包交给维护者时，改用 `multipart/form-data`。请求须携带 `Content-Length`，整个请求最多 2 MiB + 64 KiB。

| Part | 约定 |
| --- | --- |
| `requestId` | 32 位小写十六进制。重试时复用原 ID、正文和 ZIP 字节。 |
| `content` | UTF-8 文本，去除首尾空白后为 8–2000 个字符。首行为 `[Bug] 具体标题`，再填写报告问题模板字段。 |
| `public` | 文本 `true`，确认公开发布文字反馈。 |
| `diagnosticsConsent` | 文本 `true`，确认上传诊断包供维护者查看。 |
| `diagnostics` | 一个 `application/zip` 文件，压缩大小最多 2 MiB，解压总大小最多 4 MiB。只允许根目录中的 `diagnostics.txt` 和 `logs.txt`，两项均须为 UTF-8 普通文件。 |

成功仍返回 `202`，回执增加 `hasDiagnostics: true`。相同账号重试相同附件请求会返回原回执。七天内使用已有 ID 更换正文、ZIP 或在有附件和纯文字之间切换会返回 `409`。收到 `413` 时应缩小上传包；`400` 表示 ZIP、反馈类型或同意字段无效；`408` 表示上传超时；`503` 表示附件存储、上传或反馈通道暂不可用。

客户端先按现有导出流程脱敏。服务端校验、再次遮盖常见凭据和个人信息，再保存重新打包的 ZIP。日志不会进入 CurrentMusicAI 输入或公开 Issue。Issue 在「截图与诊断信息」中包含 CurrentStation 入口，使用随机的公开附件标识。

## GET /cm/feedback/capabilities

公开接口，可在当前线路检查是否提供附件上传能力。`diagnostics.enabled` 为 `true` 时支持上传，大小上限以字节为单位。响应 `404` 或开关为 `false` 时，客户端可提交 JSON，并保留手动导出入口。

```json
{
  "diagnostics": {
    "enabled": true,
    "maxZipBytes": 2097152,
    "maxUncompressedBytes": 4194304,
    "maxRequestBytes": 2162688
  }
}
```

## GET /cm/feedback

使用同一 CurrentMusic 账号的 Bearer 令牌，传入 `?requestId=7f36287d51474c66957b3f5930604a99`。建议每 3 秒查询一次，直到进入最终状态。回执保留七天，查询不存在、已过期或其他账号的回执均返回 `404`。

```json
{
  "requestId": "7f36287d51474c66957b3f5930604a99",
  "status": "published",
  "hasDiagnostics": true,
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

## GET /cm/admin/feedback/diagnostics/{id}

管理员打开 Issue 中的 CurrentStation 链接并登录后，可下载脱敏 ZIP。接口要求通过 `Authorization` 请求头携带管理员的 CurrentMusic 会话。匿名、普通账号和已过期附件分别返回 `401`、`403` 和 `410`。成功返回 `application/zip`，并记录下载管理员、附件标识和字节数。诊断响应禁止缓存。

附件自接收起保留七天，包括 `unconfirmed` 和 `failed` 的反馈。到期立即停止下载，服务端定时删除对象，并额外保留 30 天的到期提示，之后返回 `404`。

## 自托管配置

在后端受保护的环境配置中设置 `CM_FEEDBACK_GITHUB_TOKEN`。凭据须可在 `bileizhen/CurrentMusicX` 创建 Issue，例如具备该仓库 Issues 写权限的细粒度令牌。模型继续使用 [CurrentMusicAI 配置](currentmusic-ai.md)。浏览器和第三方客户端只使用 CurrentMusic 会话令牌。

启用诊断附件时，安装 `deploy/requirements-auth.txt`，设置以下变量，并创建由后端服务用户管理的私有目录。目录权限使用 `0700`，路径需位于站点静态目录和常规备份数据目录之外。

| 变量 | 说明 |
| --- | --- |
| `CM_FEEDBACK_DIAGNOSTICS_DIR` | 存储诊断对象的绝对路径，例如 `/var/lib/currentmusic-feedback/objects`。 |
| `CM_FEEDBACK_DIAGNOSTICS_ORIGIN` | Issue 使用的固定 HTTPS 站点 origin，例如 `https://music.example.com`。该站点必须能访问 `/cm/station` 与管理员 API。 |

先部署后端，再确认各代理线路将 multipart 请求体与 Bearer 请求头原样转发、允许至少 2 MiB + 64 KiB 的请求体，并遵循 `Cache-Control: no-store`。参考仓库的 `deploy/nginx.conf.example`。PHP-FPM 入口需要关闭 PHP 的自动表单解析，可使用 `deploy/php/nginx.conf.example` 中的设置。
