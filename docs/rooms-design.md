# 一起听房间 API 与同步协议

房间通过服务端时间轴同步播放。客户端接收控制信令，再分别加载歌曲音源。每个房间默认最多 200 个同时在线的账号，同一账号的多个设备共用成员身份。以下路径以 `/cm` 为基址，所有请求使用 `Authorization: Bearer <CurrentMusic 会话令牌>`。请求 JSON 使用 `Content-Type: application/json`。

## 创建、加入和管理

| 方法 | 路径 | 权限与参数 |
| --- | --- | --- |
| POST | `/rooms` | 登录。传 `{name, password?, isPublic?, freeMode?, needApproval?, joinLocked?}`，返回 `{room}` 并加入为房主。 |
| GET | `/rooms` | 登录。按 `scope=public`（默认）浏览公开且活跃的房间，或按 `scope=mine` 查看本人拥有的房间，包括非公开和已归档房间。支持 `query` 房间名或房间号片段、`limit` 1–50（默认 20）、`offset`（默认 0）。返回 `{total, rooms}`。 |
| GET | `/rooms/search` | 登录。用 `code` 精确查找活跃房间，返回 `{room, role}`。房间号是保留前导零的 6 位字符串。 |
| GET | `/rooms/{id}` | 登录。返回 `{room, role, members, queue, timeline, latestSeq, serverTime}`。成员可见播放状态、在线成员及有权限查看的队列。进房前只能看到房间元数据，`role` 和 `timeline` 为 `null`。房主可读取已归档房间的元数据。 |
| POST | `/rooms/{id}/join` | 登录。新成员按需传 `{password}`。已经加入的成员可以重连，房主可以重新加入自己的房间。返回 `{role, room, timeline, latestSeq, serverTime}`。 |
| POST | `/rooms/{id}/leave` | 登录。退出当前账号的房间成员身份，返回 `{ok:true}`。房主仍拥有该房间。 |
| POST | `/rooms/{id}/settings` | 房主。局部更新 `{name?, password?, isPublic?, freeMode?, needApproval?, joinLocked?}`，返回 `{ok, room}`。 |
| POST | `/rooms/{id}/close` | 房主。归档并停止播放，返回 `{ok, room}`。重复归档返回当前归档状态。 |
| POST | `/rooms/{id}/reopen` | 房主。恢复房间并加入，返回 `{ok, room}`。 |
| DELETE | `/rooms/{id}` | 房主。永久删除活跃或已归档的房间，连同成员、队列、事件和封禁记录一并清理，返回 `{ok:true}`。 |

后续请求使用服务端返回的数字 `room.id`。通过邀请房间号进入时，先用 `/rooms/search` 解析，以免数字房间号与内部 ID 冲突。非公开房间可通过邀请访问。需要控制加入权限时，可设置密码或锁定新成员。房间名长度为 1–60 字符，密码最多 128 字符。创建默认公开、未锁定、普通成员点歌需审批。设置请求省略 `password` 会保留原密码，传空字符串会移除密码。

### 超时归档与恢复

- 成员在线以最近 60 秒内的入房或心跳为准。有效事件连接约每 15 秒更新在线状态，也可调用心跳接口。
- 房间连续 30 分钟没有成员心跳或房间活动后，后台巡检将其归档。巡检每 30 秒运行一次，包括服务启动时。
- 房间详情使用 `archivedAt`（Unix 秒，活跃时为 0）及 `archiveReason`（`idle` 或 `manual`）标记归档。列表沿用 `closed_at` 和 `archive_reason` 字段。
- 归档保留房间号、设置、点歌队列、播放进度与封禁名单。房主可从「我的房间」恢复。恢复后暂停在归档时的进度，房主以外的成员需要重新加入。

### 成员角色

`owner` 为房主，`admin` 为房间管理员，`member` 为普通成员。房间角色与站点管理员权限独立。

| 方法 | 路径 | 权限与参数 |
| --- | --- | --- |
| POST | `/rooms/{id}/kick` | 房主或房间管理员。传 `{userId, ban?, reason?}`。只有房主可移出管理员。 |
| POST | `/rooms/{id}/transfer` | 房主。传 `{userId}`，向另一位房间成员转让，原房主成为管理员。 |
| POST | `/rooms/{id}/admins` | 房主。传 `{userId, on}`，设置或取消管理员。 |
| GET | `/rooms/{id}/bans` | 房主。返回 `{bans:[{userId, nickname, reason, createdAt}]}`。 |
| DELETE | `/rooms/{id}/bans/{userId}` | 房主。解除封禁，返回 `{ok:true}`。 |

## 点歌与播放

| 方法 | 路径 | 权限与参数 |
| --- | --- | --- |
| GET | `/rooms/{id}/queue` | 成员。返回 `{queue}`，普通成员仅能看到自己提交的待审条目。 |
| POST | `/rooms/{id}/queue` | 成员。传 `{meta:{ncm_id,name,artists?,pic?,duration?}}`，返回 `{item,auto}`。自由模式、关闭审批或控播角色提交时直接入队。 |
| POST | `/rooms/{id}/queue/{qid}/approve` | 房主或房间管理员。采纳待审条目并追加到待播队列。 |
| POST | `/rooms/{id}/queue/{qid}/reject` | 房主或房间管理员。驳回待审条目。 |
| DELETE | `/rooms/{id}/queue/{qid}` | 提交者、房主或房间管理员。删除条目，正在播放的条目需先切换。 |
| POST | `/rooms/{id}/queue/reorder` | 房主或房间管理员。传 `{qid,index}`，将待播条目移动到待播队列内的零基位置。 |
| POST | `/rooms/{id}/play` | 房主或房间管理员。从当前进度播放，可传 `{position}`。 |
| POST | `/rooms/{id}/pause` | 房主或房间管理员。在当前时间轴位置暂停。 |
| POST | `/rooms/{id}/seek` | 房主或房间管理员。传 `{position}`，保持原播放或暂停状态。 |
| POST | `/rooms/{id}/next` | 房主或房间管理员。播放队首歌曲，无待播歌曲时暂停。 |
| POST | `/rooms/{id}/prev` | 房主或房间管理员。播放最近一首历史曲目，当前曲目回到队首。 |
| POST | `/rooms/{id}/stream/renew` | 成员。音源缺失或剩余有效期不超过 60 秒时可续签，进度和播放状态保持。 |

歌曲时长与播放位置使用毫秒。播放和续签接口返回 `{timeline, seq}`。`next` 和 `prev` 可传当前 `{trackRevision}`，并发切歌时服务端会拒绝过期操作。解析音源失败时返回 `502`，保留队列和当前时间轴。Web 在歌曲结束时由在线房主或房间管理员触发下一首。历史保留最近 50 首，待审和待播条目合计最多 200 条。

## 实时连接与重同步

| 方法 | 路径 | 用法 |
| --- | --- | --- |
| GET | `/rooms/{id}/events?since=0&wait=20` | 长轮询。返回 `{events,latestSeq,serverTime}`。每批最多 50 条，`wait` 取 0–30 秒。 |
| GET | `/rooms/{id}/events?sse=1&since=0` | SSE。生产反代也提供 `/cm/live/{id}/events?sse=1&since=0`。重连可用 `Last-Event-ID`，优先于 `since`。 |
| POST | `/rooms/{id}/sync` | 返回 `{serverNow,timeline}`，供成员校准客户端时钟。 |
| POST | `/rooms/{id}/heartbeat` | 刷新在线状态，返回 `{ok,latestSeq}`。 |

加入后用返回的 `latestSeq` 初始化连接。SSE 的 `id` 为事件序号，`event` 为类型，`data` 与长轮询事件形状一致。

```json
{"seq":42,"type":"queue","payload":{"action":"approve"},"createdAt":1790000000}
```

- 收到 `play`、`pause`、`seek`、`next`、`prev` 或 `track` 时，应用 `payload.timeline`。收到 `queue`、`join`、`leave`、`settings`、`role`、`transfer` 或 `kick` 时，可刷新详情。队列和设置事件只携带变更提示。
- 游标按房间持久化，服务重启后继续递增。服务端保留最近 200 条事件。遇到 `reset` 时重新读取房间详情并使用最新快照。长轮询应按已处理的最后一条事件继续请求，避免使用服务端的 `latestSeq` 跳过尚未收到的批次。
- 收到 `close` 时停止播放并结束连接。连接中的客户端可能收到 `manual`、`idle`、`deleted`、`removed`、`session` 或 `full` 原因。房间归档、删除、成员退出或会话失效后，重连也可能收到对应的 HTTP 错误。
- 播放位置使用 `basePosition + max(0, serverNow - baseAt)`，暂停时使用 `basePosition`。切歌和恢复播放时 `baseAt` 会留出 1.2 秒缓冲。用 `stream.url` 加载音频，用 `stream.expireAt` 判断何时续签。`serverNow`、`serverTime`、`baseAt`、`expireAt` 都是 Unix 毫秒。

## 常见状态码

| 状态码 | 含义 |
| --- | --- |
| 400 | 参数缺失、格式错误或超出范围。 |
| 401 | 缺少会话或会话已失效。 |
| 403 | 未加入、角色权限不足、房间密码错误、房间锁定或账号被封禁。 |
| 404 | 房间或条目不存在，或当前账号无法访问已归档房间。 |
| 409 | 房间或队列已满、条目已处理、没有上一首，或并发操作导致队列与曲目变化。 |
| 429 | 请求过于频繁。 |
| 502 | 音源暂时不可用，可稍后重试。 |
