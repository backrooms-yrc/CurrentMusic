# 聊天室消息、SSE 与互动

「发现 → Chat」是一个全局公共聊天室：HTTP 接口负责历史与发言，`GET /chat/live` 以 SSE（或 JSON 增量）推送实时事件。以下路径以 `/cm` 为基址；除历史/图片/成员查询外均需 `Authorization: Bearer <CurrentMusic 会话令牌>`。请求 JSON 使用 `Content-Type: application/json`。

## 接口一览

| 方法 | 路径 | 权限与参数 |
| --- | --- | --- |
| GET | `/chat/messages` | 公开。`before=<消息id>`（向更早翻页，缺省取最新）、`limit` 1–50（默认 30）。返回 `{messages}`，**时间升序**。 |
| POST | `/chat/messages` | 登录。`{content, image?, mentions?, atts?, quoteId?, mentionAll?}`（详见下节）。返回完整的消息对象（与 SSE `message` 事件 payload 同构）。 |
| DELETE | `/chat/messages/{id}` | 登录。本人或管理员软删除，返回 `{ok:true}`；SSE 广播 `delete` 事件。 |
| POST | `/chat/image` | 登录。`{file: <base64>, filename, contentType}`，返回 `{image, url}`；解码后 ≤1.5MB，魔法字节校验 jpg/png/gif/webp。同一用户两次传图至少间隔 5 秒（429）。 |
| GET | `/chat/image/{file}` | 公开。聊天图片直链，缓存 7 天。 |
| GET | `/chat/members` | 公开。`?q=` 昵称/用户名模糊搜索（@ 提及选择器用，最多 8 条）；不带 `q` 返回近 7 天活跃成员（不足用最新注册补齐）。只返回「公开到广场」的启用用户。 |
| GET | `/chat/live` | 公开。`?since=<seq>` 增量；`?sse=1` 升级为 SSE 流（建议经 `/cm/live/chat` 无缓冲命名空间）。 |

## 发言（POST /chat/messages）

请求体字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| content | string | 文本。控制字符被过滤、连续空行折叠，上限 500 字符（超出截断）。 |
| image | string | 先经 `/chat/image` 上传得到的文件名。 |
| mentions | number[] | 被 @ 的用户 id 列表：正整数、去重、最多 10 个；服务端只存 id，昵称读取时实时关联。 |
| atts | array | 引用内容卡片 `[{type:'song'|'album'|'artist'|'playlist', id, name, sub?, pic?}]`，最多 5 项；`pic` 只接受 http(s)。 |
| quoteId | number | **引用某条消息**：被引用消息必须存在且未删除（否则 400「引用的消息不存在或已删除」）。服务端只存 id。 |
| mentionAll | boolean | **@全体成员**：仅管理员（含超管/站长）可用，普通用户返回 403「只有管理员可以 @全体成员」；且 `content` 必须包含 `@全体成员` 文本（400）。 |

`content`、`image`、`atts` 至少有一项非空，否则 400「说点什么、带张图，或引用一首歌吧」。同一用户两次发言至少间隔 1.5 秒（429「发言太快啦，歇一下」）。

### 消息对象

```json
{
  "id": 128, "userId": 42, "content": "@全体成员 周五晚八点一起听歌",
  "image": "", "atts": [],
  "createdAt": 1760000000,
  "user": {"id": 42, "username": "alice", "nickname": "爱丽丝", "avatar": "...",
           "avatarDecoration": "", "title": "", "isAdmin": true, "isSuper": false,
           "isOwner": false, "isBot": false},
  "mentions": [],
  "quote": {"id": 120, "userId": 7, "nickname": "小明", "excerpt": "上周的活动太棒了"},
  "mentionAll": true,
  "streaming": false
}
```

- `mentions` 为被 @ 者的完整用户对象列表（与 `user` 同构），读取时按 id 关联——用户改昵称后历史消息依然正确。
- `quote` 为引用摘要，**读取时从原消息实时生成**，不冗余存储：
  - `excerpt` 规则：正文优先（超 100 字截断加 `…`）；纯图片消息为 `[图片]`；纯卡片消息为 `[引用] <卡片名>`；其余为 `[消息]`。
  - 原消息被删除（软删）后，已发出的引用仍能显示摘要；被环形清理淘汰（仅保留最近 500 条）后 `quote` 为 `null`，客户端应按无引用渲染。
  - 新发言只能引用未删除的消息；`quoteId=0` 或缺省表示无引用。
- `mentionAll` 是独立标记，**不占用 `mentions` 名额**；文本里的 `@全体成员` 由客户端高亮，服务端不做文本替换。
- `streaming` 仅对 AI 流式输出（`edit` 事件）有意义，历史接口恒为 `false`。

### 引用与回复的关系

- 聊天里的「引用」（`quote`）是对聊天消息的引用；「引用内容」（`atts`）是歌曲/专辑/歌手/歌单卡片，两者相互独立、可同时携带。
- 帖子评论区的「回复」是另一套接口（`POST /posts/{id}/comments` 传 `replyTo`），与本节无关。

## 实时流（GET /chat/live）

先拉历史拿到最新消息，再以 `?since=<latestSeq>` 订阅增量。SSE 模式（`?sse=1`）：

- 帧格式：`id: <seq>` / `event: <type>` / `data: {seq, type, payload, createdAt}`；
- 事件类型：`message`（新消息，payload 同消息对象）、`delete`（`{id}`）、`edit`（`{id, content, atts, streaming, updatedAt}`，AI 流式定稿用）；
- 写入 `id: seq` 后 EventSource 断线自动按最后 seq 续传；空闲 15 秒发 `: ping` 心跳；连接最长 1 小时，客户端应自行重连；
- 事件表环形保留最近 200 条；断线过久时先用 `GET /chat/messages` 重建历史再订阅；
- 不带 `sse=1` 时直接返回 JSON `{events, latestSeq}`，可作轮询兜底（前端在 SSE 不可用（如旧 WebView）时每 3 秒轮询一次）。

## 客户端实现提示

- @ 提及：本地先过滤近期成员，再以 180ms 防抖调 `/chat/members?q=`；发送前把「内容里确实出现的 `@昵称`」换算成 id 列表。长按他人头像可快捷插入 `@昵称`。
- @全体成员：选择器对管理员置顶展示「@全体成员」项；普通用户手打该文本只会得到普通消息（`mentionAll` 不会被置真），界面高亮仅是展示层行为。
- 引用交互：消息头部「引用」按钮把目标消息挂到输入框上方（可取消），发送时带 `quoteId`；气泡内引用卡可点击回跳原消息，原消息不在当前列表时给降级提示。
- 图片：发送前建议本地压缩（如长边 1280px JPEG）再 base64 上传，与 1.5MB 服务端上限匹配。
- 删除：软删除后列表接口不再返回该消息；引用它的消息不受影响。
