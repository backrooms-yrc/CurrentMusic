# RealIP 透传策略

CurrentMusic 代理网易云接口时，默认以服务器 IP 请求上游。某些场景下需要把**可信的客户端
真实 IP** 作为 `realIP` 传给上游，让网易云按用户网络位置选择 CDN 边缘或执行风控。

## 可信取值链

只使用服务端解析出的 IP，**绝不接受调用方参数里的 `realIP`**：

1. nginx 覆盖写入的 `X-Real-IP`；
2. `X-Forwarded-For` 的最后一跳（nginx 追加）；
3. TCP `client_address`。

实现见 `backend/cm_ncm_gateway.py::client_ip()`。网关的
`normalize_params()` 会把客户端提交的 `realIP` 当作保留参数剥离，之后再由服务端注入。

## 当前会透传的范围

| 范围 | 方法 | 说明 |
|---|---|---|
| 媒体地址族 | GET/POST | `/song/url`、`/song/download/url`、`/mv/url`、`/video/url`、`/song/cloud/download`、`/voice/detail`；上游按 realIP 选就近 CDN 边缘 |
| 账号写操作（通用转发） | 非 GET | T2/T3 写接口；例如歌单创建/修改/增删曲目/排序、收藏、云盘上传/删除 |
| 网易云红心 | POST | `POST /ncmbind/like/{ncmId}` |
| 关注/取关歌手 | POST | `POST /artists/{id}/follow` |
| 评论、回复、删评 | POST/DELETE | `POST|DELETE /ncmbind/comment/{ncmId}` |
| 评论点赞 | POST | `POST /ncmbind/comment-like/{ncmId}` |

判定函数：`cm_ncm_gateway.should_forward_real_ip(path, method, tier)`。

## 不会透传的范围

- 公共缓存只读接口（T0/T1 GET）：搜索、歌词、歌曲详情、歌单详情、图片等；
- 按账号 cookie 决定的推荐流、私人歌单、喜欢列表；
- 自建数据库和本站业务逻辑；
- AI/DeepSeek 请求；
- 图片、封面等静态资源。

公共只读接口如果以后确认存在地区差异，必须同时把 realIP 纳入缓存键或按地区分缓存，
否则会把一个地区的响应缓存给另一个地区；当前不这么做。

## 缓存与日志

- 媒体请求本身不走网关缓存（直链会过期）。
- RealIP 在缓存键计算**之后**注入，避免公开缓存按 IP 碎片化。
- 写操作不缓存。
- 审计日志只记录接口、用户和参数键，不记录 Cookie/RealIP 值。

## 隐私

透传 RealIP 意味着网易云会看到用户出口 IP；媒体请求此前已经这样做了。本策略把范围扩大到
账号写操作，用于评论 IP 属地与风控一致性。隐私说明需要与实现保持一致，不向无关第三方转发。
