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
| `mediaConsent`、`media` | 同时附带截图或录屏时，分别传入文本 `true` 与 UTF-8 JSON 清单文本。 |

成功仍返回 `202`，回执增加 `hasDiagnostics: true`。相同账号重试相同附件请求会返回原回执。七天内使用已有 ID 更换正文、ZIP 或在有附件和纯文字之间切换会返回 `409`。收到 `413` 时应缩小上传包；`400` 表示 ZIP、反馈类型或同意字段无效；`408` 表示上传超时；`503` 表示附件存储、上传或反馈通道暂不可用。

客户端先按现有导出流程脱敏。服务端校验、再次遮盖常见凭据和个人信息，再保存重新打包的 ZIP。日志不会进入 CurrentMusicAI 输入或公开 Issue。Issue 在「截图与诊断信息」中包含 CurrentMusic 网页管理员面板的链接，使用随机的公开附件标识。

## GET /cm/feedback/capabilities

公开接口，可在当前线路检查是否提供附件上传能力。大小上限以字节为单位。分别读取 `diagnostics.enabled` 与 `media.enabled`。媒体开关缺失或关闭时，仍可提交文字、使用已启用的 ZIP 接口，或按原流程手动补传。

```json
{
  "diagnostics": {
    "enabled": true,
    "maxZipBytes": 2097152,
    "maxUncompressedBytes": 4194304,
    "maxRequestBytes": 2162688
  },
  "media": {
    "enabled": true,
    "screenshot": {"maxCount": 3, "maxBytes": 2097152, "contentTypes": ["image/jpeg", "image/png"], "maxLongEdge": 4096, "maxPixels": 12000000},
    "video": {"maxCount": 1, "maxBytes": 26214400, "contentTypes": ["video/mp4"], "maxDurationSeconds": 30, "maxLongEdge": 1920, "maxShortEdge": 1080},
    "maxTotalBytes": 32505856,
    "stagingTtlSeconds": 3600
  }
}
```

## PUT /cm/feedback/{requestId}/media/{slot}

报告问题时，客户端预览附件并取得单独授权后，逐个暂存文件。请求使用 HTTPS 和 `Authorization: Bearer <CurrentMusic 会话令牌>`。`requestId` 须为 32 位小写十六进制字符串，`slot` 取 `screenshot-1`、`screenshot-2`、`screenshot-3` 或 `video-1`。

发送原始文件字节，并提供实际 `Content-Type`、`Content-Length` 和 `X-Feedback-Media-Consent: true`。支持最多三张 JPEG/PNG 截图和一段 H.264 MP4，录屏可包含一条 AAC 音轨。截图重新编码并应用 EXIF 方向，录屏保留支持的画面及音轨并移除源容器元数据。通知、声音和画面中的私人内容需在预览时检查和遮挡。缺少 H.264 解码的浏览器会提示先用本地播放器检查录屏。

首次暂存返回 `201`。同账号、请求 ID、槽位和文件重试返回 `200` 及原回执。请保存 `sha256` 用于最终提交，`expiresAt` 是 UTC ISO 8601 时间。

```json
{"slot":"screenshot-1","sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","expiresAt":"2026-11-19T08:00:00Z"}
```

| HTTP | 含义 |
| --- | --- |
| `400` / `408` | 缺少授权或长度无效，或上传中断、超时。断线后可重试相同文件、ID 与槽位。 |
| `409` | 槽位已有不同文件，需先移除。反馈接收后全部槽位锁定。 |
| `413` | 文件或媒体总大小超限。ZIP 独立计入自己的限额。 |
| `415` | 文件类型、容器或编码不支持。 |
| `422` | 文件损坏、截图尺寸或录屏尺寸、时长超限。 |
| `429` / `503` | 暂存配额或频率超限，或处理、存储暂不可用。 |

### DELETE /cm/feedback/{requestId}/media/{slot}

同一账号可在反馈接收前移除暂存文件。成功返回 `204`。提交后返回 `409`。未提交文件暂存一小时，暂存不占用每日反馈提交次数。

### 提交随附媒体的 Bug

继续使用 `POST /cm/feedback`。仅媒体用 JSON，同时附带诊断 ZIP 时用现有 multipart。提交时使用首行 `[Bug] 具体标题`，加布尔值 `mediaConsent: true` 和 `media` 清单。清单各项包含唯一 `slot` 及暂存回执的 `sha256`。

```json
{"requestId":"7f36287d51474c66957b3f5930604a99","content":"[Bug] 切换歌曲时界面卡住\n快速换歌后出现。","public":true,"mediaConsent":true,"media":[{"slot":"screenshot-1","sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}]}
```

接收时服务端会锁定清单，回执增加 `mediaCount`。引用缺失、过期或摘要不符时返回 `409` 和 `code: "media_not_ready"`，可补传或移除相应附件再提交。已接收请求只允许用相同正文、ZIP 和媒体清单重试。清单顺序可以不同。内容变更返回 `409` 和 `code: "request_conflict"`。客户端遇到发布结果未知时先查回执，避免重复创建 Issue。

## GET /cm/feedback

使用同一 CurrentMusic 账号的 Bearer 令牌，传入 `?requestId=7f36287d51474c66957b3f5930604a99`。建议每 3 秒查询一次，直到进入最终状态。回执保留七天，查询不存在、已过期或其他账号的回执均返回 `404`。

```json
{
  "requestId": "7f36287d51474c66957b3f5930604a99",
  "status": "published",
  "hasDiagnostics": true,
  "mediaCount": 1,
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

## GET /cm/admin/feedback/attachments/{id}

Issue 链接打开 CurrentMusic 网页的「管理员面板 → 反馈诊断」。管理员用现有 Web 会话查看附件列表。响应的 `attachments` 每项含 `id`、`slot`、`contentType`、`size`，ZIP 的槽位为 `diagnostics`。同组媒体与 ZIP 共用一条公开入口。模型仅接收反馈文字，Issue 不公开媒体字节、原始文件名或存储键。

## GET /cm/admin/feedback/media/{id}

用列表中的媒体 `id` 下载清理后的 JPEG、PNG 或 MP4。仅接受管理员 Bearer 会话。服务端记录管理员、附件标识、类型、操作和已响应的字节数。响应禁止缓存。匿名、普通账号和已过期附件分别返回 `401`、`403` 和 `410`。

## GET /cm/admin/feedback/diagnostics/{id}

Issue 中的链接会打开 CurrentMusic 网页的「管理员面板 → 反馈诊断」并填入附件标识。管理员可使用网页现有会话下载脱敏 ZIP。旧版 Issue 链接会转到同一入口。下载 API 通过 `Authorization` 请求头验证管理员的 CurrentMusic 会话。匿名、普通账号和已过期附件分别返回 `401`、`403` 和 `410`。成功返回 `application/zip`，并记录下载管理员、附件标识和字节数。诊断响应禁止缓存。

附件自接收起保留七天，包括 `unconfirmed` 和 `failed` 的反馈。到期立即停止下载，服务端定时删除对象，并额外保留 30 天的到期提示，之后返回 `404`。

## 自托管配置

在后端受保护的环境配置中设置 `CM_FEEDBACK_GITHUB_TOKEN`。凭据须可在 `bileizhen/CurrentMusicX` 创建 Issue，例如具备该仓库 Issues 写权限的细粒度令牌。模型继续使用 [CurrentMusicAI 配置](currentmusic-ai.md)。浏览器和第三方客户端只使用 CurrentMusic 会话令牌。

启用诊断附件时，安装 `deploy/requirements-auth.txt`，设置以下变量，并创建由后端服务用户管理的私有目录。目录权限使用 `0700`，路径需位于站点静态目录和常规备份数据目录之外。

| 变量 | 说明 |
| --- | --- |
| `CM_FEEDBACK_DIAGNOSTICS_DIR` | 存储诊断对象的绝对路径，例如 `/var/lib/currentmusic-feedback/objects`。 |
| `CM_FEEDBACK_DIAGNOSTICS_ORIGIN` | Issue 使用的固定 HTTPS 站点 origin，例如 `https://music.example.com`。该站点必须提供 `/app/` 与管理员 API。 |
| `CM_FEEDBACK_MEDIA_HOSTS` | 已完成媒体上线验收的代理 `Host`，逗号分隔。留空时关闭媒体能力。 |

先部署后端，再确认各代理线路将 multipart 请求体与 Bearer 请求头原样转发、允许至少 2 MiB + 64 KiB 的请求体，并遵循 `Cache-Control: no-store`。参考仓库的 `deploy/nginx.conf.example`。PHP-FPM 入口需要关闭 PHP 的自动表单解析，可使用 `deploy/php/nginx.conf.example` 中的设置。

开启媒体时需为后端安装 Pillow、FFmpeg 与 ffprobe，在 `CM_FEEDBACK_DIAGNOSTICS_DIR` 下创建权限为 `0700` 的 `media` 目录。代理需透传原始 PUT、Bearer 与 `X-Feedback-Media-Consent`，为媒体上传允许 25 MiB，并允许处理阶段最多 180 秒。Web、暂存、提交和回执接口需指向同一后端状态库。逐条核对各线路后再把对应 Host 加入开关。PHP 入口启用媒体时还需为对应站点调整 `client_max_body_size` 和 PHP 进程内存限制。
