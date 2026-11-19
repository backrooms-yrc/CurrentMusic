# 个人主页、横幅与帖子

本文路径以 `/cm` 开头。写接口携带 `Authorization: Bearer YOUR_CURRENTMUSIC_TOKEN`，有 JSON 请求体时使用 `Content-Type: application/json`。

## 主页横幅

`GET /cm/auth/me`、`GET /cm/profile` 返回当前账号的 `bannerUrl`。`GET /cm/users/{id}/profile` 可匿名读取，横幅字段位于 `user.bannerUrl`。空串表示未设置。将非空值接在当前 API 基地址（包含 `/cm`）后，例如 `https://music.20110208.xyz/cm/users/42/banner?v=...`。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| PUT | `/cm/profile/banner` | 用 JSON `{"data":"BASE64_IMAGE"}` 上传或替换当前账号的横幅，返回 `{"bannerUrl":"/users/42/banner?v=..."}` |
| DELETE | `/cm/profile/banner` | 清除当前账号的横幅。重复删除仍返回 `{"bannerUrl":""}` |
| GET | `/cm/users/{id}/banner` | 公开读取当前横幅，返回 `image/jpeg`。可用 `v` 指定版本，与当前版本一致时支持 ETag 验证 |

上传接受 JPEG、PNG、WebP 的标准 Base64 字符串，解码后最多 1 MiB、最多 2500 万像素。服务端按 EXIF 校正方向，居中裁剪为 4∶1 并转成 JPEG，最长边最多 1600 像素。上传格式错误或超过限制返回 400，图片处理组件不可用返回 503。读取缺失、已移除或已替换的版本返回 404。用户横幅会公开展示。

## 发布与浏览帖子

`POST /cm/posts` 需要登录。标题选填，为修剪首尾空白后最多 80 字的单行字符串。正文必填，修剪后最多 5000 字，以 Markdown 原文保存。音乐附件最多 5 项，类型为 `song`、`album`、`artist` 或 `playlist`，每项至少包含 `type` 与 `id`。

```json
{
  "title": "夜间通勤歌单",
  "content": "分享一首最近反复播放的歌。",
  "attachments": [{"type":"song","id":123,"name":"示例歌曲"}]
}
```

发布成功返回 `{"id":123}`。旧客户端可省略标题，旧帖子与无标题帖子在读取时的 `title` 为 `""`。

`GET /cm/posts?offset=0&limit=20&author=42` 按帖子 ID 降序返回 `{"posts":[...],"total":1}`。`author` 选填，`offset` 默认 0，`limit` 默认为 20、范围为 1 至 50。`GET /cm/posts/{id}` 返回 `{"post":{...}}`，帖子不存在返回 404。两个接口使用同一种帖子结构。

```json
{
  "post": {
    "id": 123,
    "title": "夜间通勤歌单",
    "content": "分享一首最近反复播放的歌。",
    "attachments": [{"type":"song","id":123,"name":"示例歌曲"}],
    "createdAt": 1794960000,
    "author": {
      "id":42,"nickname":"听众","avatar":"","avatarDecoration":"",
      "isAdmin":false,"isSuper":false,"isOwner":false,"title":""
    },
    "likeCount": 2,
    "commentCount": 1,
    "likedByMe": false,
    "canDelete": false
  }
}
```

列表和详情均支持匿名读取，携带当前会话可得到个人的 `likedByMe` 和 `canDelete`。`post.title` 是帖子标题，`post.author.title` 是作者的站内头衔。`POST /cm/posts/{id}/like` 以 JSON `{"on":true}` 设置点赞状态，返回当前 `likeCount`。`DELETE /cm/posts/{id}` 仅允许作者或管理员调用。

## 评论和回复

- `GET /cm/posts/{id}/comments` 可匿名读评论。省略分页参数时返回 `{"comments":[...]}`，最多 100 条。
- `GET /cm/posts/{id}/comments?after=0&limit=30` 按评论 ID 升序返回 `{"comments":[...],"nextAfter":123}`。用上次的 `nextAfter` 请求下一页，`null` 表示读到末尾。`after` 默认 0，`limit` 默认 30，范围为 1 至 100。分页参数无效返回 400。
- `POST /cm/posts/{id}/comments` 需要登录，请求为 `{"content":"评论正文","replyTo":123}`，返回 `{"id":124}`。正文最多 500 字。`replyTo` 可省略，存在时必须指向同一帖子内的评论。
- 每条评论包含 `id`、`postId`、`content`、`createdAt`、`author`、`replyTo`。`replyTo` 包含目标的 `id`、`userId`、`nickname`，普通评论和目标已删除的回复返回 `null`。`DELETE /cm/posts/comments/{id}` 允许评论作者或管理员删除评论。

Web 草稿保存在当前设备，并按 API 地址和账号隔离。发布成功或手动丢弃时清除对应草稿。
