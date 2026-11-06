# 网易云评论

评论列表和楼层回复可匿名读取。传入 CurrentMusic Bearer 会话且已有效绑定网易云时，`meUid` 为绑定的网易云用户 ID，`likedByMe` 反映该账号对当前评论的点赞状态。游客和未绑定账号得到 `meUid: 0` 与 `likedByMe: false`。绑定失效时会以匿名身份重试读取。读取响应使用 `Cache-Control: private, no-store`。

## 评论列表

`GET /cm/ncm/comments/page` 支持推荐、热度和时间三种排序。页大小固定后应在同一次翻页过程中保持一致。

| 查询参数 | 说明 |
| --- | --- |
| `type` | `0` 歌曲、`1` MV、`2` 歌单、`3` 专辑、`4` 电台节目、`5` 视频、`6` 动态。默认 `0` |
| `id` | 资源 ID。视频使用 `vid`，动态使用完整 `A_EV_2_…` 线程 ID |
| `sort` | `recommended` 推荐、`hot` 最热、`latest` 最新。默认 `recommended` |
| `page` | 从 `1` 开始的页码，默认 `1` |
| `limit` | 每页请求数量，默认 `20`，范围 `1`–`50`。推荐页可能包含上游插入的额外评论 |
| `cursor` | 最新排序从第二页开始原样传回上一页的 `nextCursor`，其余排序递增 `page` 即可 |

返回 `comments`、`total`、`more`、`nextCursor`、`meUid`。`more: false` 表示分页结束。推荐页跨页可能有重复条目，客户端可按评论 `id` 去重。

每条评论提供 `id`、`userId`、`nickname`、`avatar`、`content`、`time`（毫秒）、`liked`（点赞数）、`likedByMe`、`beNickname`、`beContent` 和 `replyCount`。评论 `id` 为字符串，适合直接用于后续请求。

## 展开楼层回复

`GET /cm/ncm/comments/replies` 使用同一组 `type`、`id` 和 `limit` 参数，另外传入父评论 `commentId`。首次展开省略 `cursor`，有下一页时把 `nextCursor` 原样传回。返回结构与评论列表一致，`total` 表示该楼层的回复数，`comments` 只包含回复。可用 `replyCount` 显示展开按钮并在展开时请求首批回复。

## 发表评论、回复和点赞

写入请求须携带 CurrentMusic Bearer 会话，并绑定网易云账号。请求使用 `application/json`，包含 `confirm: 1`，成功时上游 `code` 为 `200`。写操作与绑定账号读取均绕过上游缓存。接口会根据可信代理信息向上游传递 RealIP。

| 方法及路径 | JSON 参数 |
| --- | --- |
| `POST /cm/ncm/comment` | `id`、`type`、`t`、`confirm`。`t=1` 发评，带 `content`。`t=2` 回复，带 `commentId`、`content`。`t=0` 删除，带 `commentId` |
| `POST /cm/ncm/comment/like` | `id`、`type`、`cid`（评论 ID）、`t`、`confirm`。`t=1` 点赞，`t=0` 取消点赞 |

对动态执行写入时传 `type: 6` 和 `threadId`，使用完整的 `A_EV_2_…` 线程 ID。客户端应在服务端确认成功后更新点赞样式和计数，失败时保留原状态。

参数错误返回 `400`，未登录或未绑定的写操作返回 `401`，网易云返回失败时返回 `502` 与 `error`。旧版 `/cm/ncm/comments`、`/cm/ncm/comment/floor` 及原有歌曲评论写接口仍按各自契约提供服务。
