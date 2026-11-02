# 多人实时听歌房 · 设计文档（v1）

> 目标：突破"一起听仅两人"的限制，支持 **200 人/房**的房间；房主统一控播，房员端低延迟同步。

## 0. 现有基础设施约束（决定技术选型）

| 约束 | 现状 | 对设计的影响 |
|---|---|---|
| 后端框架 | `http.server.ThreadingHTTPServer`（python 标准库）+ sqlite WAL | 无 WebSocket 栈；SSE 是纯 HTTP 长连接，天然兼容 |
| 并发模型 | 线程/连接（daemon thread） | 长连接 = 1 线程；500 连接约占 30~50MB，可接受 |
| 限流 | 每 IP 300 req/min（后端）+ 120 req/min（nginx） | 长连接只算 1 次请求；长轮询回退需单独配额 |
| nginx | `/cm/` 已反代到 3010，`proxy_read_timeout 120s` | SSE 需新增长超时 + `proxy_buffering off` 的独立 location |
| 音频来源 | NCM 直链（签名 CDN，有效期 ~1200s，任意 IP 可播） | **音频不走我们服务器**：只广播信令，每人各自拉流 |
| App 页面源 | 伪源 `https://cm.local`（安全上下文） | App 内 `EventSource` 到 `http://` 后端会被**混合内容**拦截 → 需原生 SSE 桥或长轮询回退 |

## 1. 数据库表设计（sqlite）

```sql
-- 房间（含权威播放时间轴）
CREATE TABLE rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,          -- 6 位房间号（分享/搜索）
  name TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  salt TEXT DEFAULT '',               -- 房间密码（pbkdf2 加盐，空=公开房）
  password_hash TEXT DEFAULT '',
  is_public INTEGER DEFAULT 1,        -- 是否出现在房间广场
  free_mode INTEGER DEFAULT 0,        -- 自由点歌模式（开启后全员免审批）
  need_approval INTEGER DEFAULT 1,    -- 普通房员点歌是否需审批
  join_locked INTEGER DEFAULT 0,      -- 禁止新成员加入
  max_members INTEGER DEFAULT 200,
  closed_at INTEGER DEFAULT 0,
  -- 当前曲目与时间轴（权威状态，全房以此对时）
  track_ncm_id INTEGER DEFAULT 0,
  track_meta TEXT DEFAULT '',         -- JSON: name/artists/pic/duration
  stream_level TEXT DEFAULT '',       -- 实际档位（lossless/jymaster…）
  stream_url TEXT DEFAULT '',         -- 已签名直链
  stream_expire_at INTEGER DEFAULT 0, -- 直链过期时间（提前 60s 主动续签）
  base_position INTEGER DEFAULT 0,    -- 该曲起始播放位置(ms)
  base_at INTEGER DEFAULT 0,          -- 时间轴基准：服务器毫秒时间戳
  playing INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_rooms_public ON rooms(is_public, closed_at, updated_at DESC);
CREATE INDEX idx_rooms_owner  ON rooms(owner_id, closed_at);

-- 成员与角色
CREATE TABLE room_members (
  room_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',  -- owner | admin | member
  nickname TEXT DEFAULT '',             -- 快照，避免每次联表
  avatar TEXT DEFAULT '',
  muted INTEGER DEFAULT 0,              -- 禁言/禁点歌（预留）
  joined_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,           -- 心跳（15s）
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX idx_room_members_user ON room_members(user_id, last_seen DESC);

-- 点歌队列（含审批流）
CREATE TABLE room_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL,
  ncm_id INTEGER NOT NULL,
  name TEXT NOT NULL, artists TEXT DEFAULT '', pic TEXT DEFAULT '', duration INTEGER DEFAULT 0,
  requested_by INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|queued|playing|played|rejected|skipped
  seq INTEGER NOT NULL DEFAULT 0,         -- 播放顺序（采纳时分配）
  reviewed_by INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER DEFAULT 0
);
CREATE INDEX idx_room_queue ON room_queue(room_id, status, seq);

-- 事件环形日志（断线重连补发 / Last-Event-ID）
CREATE TABLE room_events (
  room_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,               -- 房间内自增
  type TEXT NOT NULL,                 -- join|leave|queue|approve|reject|track|play|pause|seek|mode|role|kick|close
  payload TEXT NOT NULL,              -- JSON
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, seq)
);

-- 封禁名单（被踢者禁止再次加入）
CREATE TABLE room_bans (
  room_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  reason TEXT DEFAULT '', banned_by INTEGER NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
```

清理策略：`room_events` 每房保留最近 200 条（房间关闭即删）；`rooms.closed_at` 后 24h 物理删除。

## 2. API 定义

鉴权：全部 `Authorization: Bearer <token>`（复用现有多端会话）。错误码：`400` 参数、`401` 未登录、`403` 无权限（非房主/管理员）、`404` 房间不存在、`409` 已满/已加密密码错、`429` 频率限制。

### 2.1 房间

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| POST | `/rooms` | 创建 `{name, password?, isPublic?, freeMode?, needApproval?}` → `{room}` | 登录 |
| GET | `/rooms` | 广场：`?scope=public&query=&limit=&offset=`（按活跃度排序，含当前曲目与人气） | 登录 |
| GET | `/rooms/search` | 房间号精确：`?code=123456` | 登录 |
| GET | `/rooms/<id>` | 详情：房间 + 成员(前 50) + 时间轴 + 队列（进房前预览） | 登录 |
| POST | `/rooms/<id>/join` | 加入 `{password?}` → `{member, timeline, serverTime, sinceSeq}` | 登录 |
| POST | `/rooms/<id>/leave` | 离开 | 成员 |
| POST | `/rooms/<id>/close` | 解散（房主） | owner |
| POST | `/rooms/<id>/kick` | 踢出 `{userId, ban?}` | owner/admin |
| POST | `/rooms/<id>/transfer` | 转让房主 `{userId}` | owner |

### 2.2 权限与设置

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| POST | `/rooms/<id>/admins` | 授权/撤销管理员 `{userId, on}` | owner |
| POST | `/rooms/<id>/settings` | `{freeMode?, needApproval?, isPublic?, password?, joinLocked?}` | owner |

### 2.3 点歌与审批

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| POST | `/rooms/<id>/queue` | 点歌 `{ncmId, meta}`：自由模式或 owner/admin → 直接 `queued`；否则 `pending` | 成员 |
| GET | `/rooms/<id>/queue` | 队列（含 pending 列表，管理员可见全部；普通成员只看自己 pending） | 成员 |
| POST | `/rooms/<id>/queue/<qid>/approve` | 采纳 → 分配 seq 并广播 | owner/admin |
| POST | `/rooms/<id>/queue/<qid>/reject` | 驳回 `{reason?}` | owner/admin |
| DELETE | `/rooms/<id>/queue/<qid>` | 撤回（本人）/ 移除（管理员） | 本人/管理员 |
| POST | `/rooms/<id>/queue/reorder` | 排序 `{qid, seq}` | owner/admin |
| POST | `/rooms/<id>/playlist` | **管理员编辑房主歌单** `{songs[], mode: replace\|append\|playNow}` | owner/admin |

### 2.4 播放控制（owner/admin）

`POST /rooms/<id>/play {position?}` · `/pause` · `/seek {position}` · `/next` · `/prev` · `/stream/refresh`（直链续签）

### 2.5 信令与同步

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/rooms/<id>/events?since=<seq>` | **SSE 长连接**（`text/event-stream`）；支持 `Last-Event-ID` |
| GET | `/rooms/<id>/events?since=&wait=25` | **长轮询回退**（App 旧版/SSE 不可用），最多挂起 25s |
| POST | `/rooms/<id>/sync` | 时钟同步 `{clientNow}` → `{serverNow, timeline}` |
| POST | `/rooms/<id>/ready` | 缓冲上报 `{ready: bool, bufferedMs}` |
| POST | `/rooms/<id>/heartbeat` | 成员心跳（15s），返回是否有待下发事件 |

### 2.6 SSE 事件格式

```
event: state|queue|track|play|pause|seek|members|mode|role|close
id: <seq>                       ← 断线重连时用 Last-Event-ID 补发
data: {"seq":123,"servedAt":1790000000123, ...}
```
关键事件 `track`（切歌）载荷：
```json
{ "seq": 124, "servedAt": 1790000000123,
  "track": {"ncmId": 1901371647, "name": "孤勇者", "artists": "陈奕迅", "pic": "...", "duration": 265000},
  "stream": {"url": "http://m7.music.126.net/....flac", "level": "jymaster", "br": 5085163, "expireAt": 1790001200000},
  "timeline": {"basePosition": 0, "baseAt": 1790000000500, "playing": true},
  "nextHint": {"ncmId": 26060065, "name": "Counting Stars"}   // 预取用
}
```

## 3. 音频实时同步核心技术方案

### 3.1 总体：服务器只发信令，音频各自拉流

```
        ┌──────── 控制信令（SSE，每事件 ~200B）────────┐
房主端 ──┤ POST /play|pause|seek|next  →  rooms 表时间轴  ├──→ 100+ 房员端
        └──────────────────────────────────────────────┘
音频：房员各自向 NCM CDN 拉当前曲（签名直链 20 分钟内任意 IP 可播）→ 服务器带宽 ≈ 0
```

### 3.2 权威时间轴（唯一真相在服务端）

```
pos(serverNow) = basePosition + (playing ? serverNow - baseAt : 0)
```
- 播放：`basePosition = 当前进度`、`baseAt = 服务器毫秒`、`playing = 1`
- 暂停：`basePosition = pos(now)`、`playing = 0`
- 拖动：`basePosition = 目标位置`、`baseAt = now`
- 切歌：换 track 并置 `basePosition = 0`、`baseAt = now`

客户端**不信任本地直觉**，每 1s 按上式重算目标位置。

### 3.3 时钟同步（NTP 式，消除手机时间不准）

客户端连发 5 次 `POST /sync`（间隔 200ms），取 **RTT 最小**的一次计算偏移：
```
offset = serverNow - (clientSendTime + rtt/2)
serverNow_client = clientNow + offset
```
精度：同城 ±15ms、跨国 ±60ms（已足够）。

### 3.4 漂移检测与三级纠正

```
desired = pos(serverNow_client)          // 目标位置(ms)
drift   = audio.currentTime*1000 - desired
```
| 漂移 | 动作 |
|---|---|
| < 300ms | 不处理（人类对 <300ms 的音乐错位基本无感） |
| 300 ~ 1200ms | `playbackRate = 1±0.03` 微调（音乐变速 3% 几乎听不出），持续到 |drift|<100ms 后恢复 1.0 |
| > 1200ms | 硬 seek 到 desired（允许一次可听跳变） |

补充：`playbackRate` 微调需在 3~5s 内收敛；若用户设备负载导致 `timeupdate` 抖动，用 `audio.currentTime` 而非 `performance.now()` 计算。

### 3.5 切歌与缓冲协同

1. 房主切歌 → 服务端解析直链（已缓存则 0ms）→ 落库时间轴 → 广播 `track`
2. 各端收到 `track`：立即 `src=url`、`currentTime = pos(serverNow_client)`、`play()`
3. **等待缓冲（房主可选）**：客户端上报 `ready`（`readyState>=3` 或 500ms 内可播），服务器在 **90% 成员 ready 或 3 秒宽限**后下发 `state{playing:true}` 统一起播 → 百人房首播偏差可压到 <400ms
4. **预取**：`track` 事件带 `nextHint`，各端后台预热下一首（`preload="auto"` 静默预加载）→ 切歌近乎瞬时

### 3.6 直链过期与续签

NCM 直链有效期 ~1200s。服务端在 `stream_expire_at - 60s` 主动 `refresh`，成功则广播 `track{stream}`（**保持 timeline 不变**），客户端用新 URL 无缝换源（`currentTime` 对齐后替换）。

### 3.7 延迟预算（实测预期）

| 环节 | 耗时 |
|---|---|
| 房主点击 → 服务端落库 + 广播 | 30~80ms |
| SSE 推送至房员（同城/跨国） | 40~300ms |
| 客户端时钟偏移估计误差 | ±15~60ms |
| 缓冲/起播 | 0（预取命中）~800ms |
| **端到端同步偏差** | **≤500ms（目标），最差 ≤1.2s** |

## 4. 容量、运维与改造

| 项目 | 方案 |
|---|---|
| 单房上限 | 200 人（`rooms.max_members` 可调） |
| 全局并发连接 | 建议 ≤500（2 核 1.9G 实测余量：500 线程 ≈ 30~50MB）；接近上限时新连接返回 503 并提示 |
| nginx | 新增 `location ^~ /cm/rooms/`：`proxy_buffering off; proxy_cache off; proxy_read_timeout 1h; proxy_http_version 1.1; proxy_set_header Connection '';` |
| 后端限流 | SSE 连接不计入请求计数；房间命令单独配额（每人 20 次/分钟，点歌 1 首/30 秒、队列上限 50） |
| 事件补发 | `room_events` 环形 200 条 + `Last-Event-ID` → 断网重连无状态丢失 |
| 房主掉线 | 30s 无心跳自动转让给最早加入的管理员；无人则房间挂起，5 分钟无活动自动关闭 |
| 监控 | 管理面板新增「房间」页：活跃房间/连接数/事件速率/踢人与封禁 |

## 5. 前端页面与交互

- `#/rooms` **房间广场**：卡片流（房名/房主/人数/当前曲目/🔒密码房/自由模式标记）+ 房间号或房名搜索 + 创建房间
- `#/room/:code` **房间页**：房间信息 + 成员墙（头像+角色标记）+ 当前播放卡（封面/进度/跟着房间的播放态）+ 队列（含审批按钮，owner/admin 可见）+ 底部操作栏（房主：播放/暂停/上一首/下一首/模式开关；成员：点歌）
- **分享**：`http://music.example.com/app/#/room/<code>` + 一键复制房间号
- **与全局播放器的关系**：进房后播放器进入「跟随模式」——本地控制禁用（显示「跟随房间」徽标），退出房间恢复本地队列

## 6. 分阶段落地

| 阶段 | 内容 | 预估 |
|---|---|---|
| **MVP** | 房间 CRUD/加入/角色/队列审批/SSE 状态与切歌同步/等待缓冲 | 1~2 天 |
| **阶段 2** | 速率微调、断线补发、房主转让、广场排序、管理面板接入 | 1 天 |
| **阶段 3** | 房间内聊天/弹幕、跨房联播、（如需语音再引 WebSocket 单独服务） | 按需 |

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| App 内 SSE 被混合内容拦截（伪源 https → 后端 http） | **原生 SSE 桥**（Java 流式读取 + JS 回推，约 60 行）；旧版本 App 走长轮询 |
| 百人房同时请求直链打爆上游 | 直链由服务端**解析一次**广播复用（N 人共享 1 条 URL），并对解析结果缓存 |
| 地区限制曲目 | 服务端统一解析；失败则跳过并广播提示（房主可换曲） |
| 时钟漂移导致逐渐不同步 | 每秒重算 + 三级纠正；不使用客户端绝对时钟 |
| 滥用（刷歌/拉人） | 默认开启审批制；点歌频控；管理员面板可关闭房间/封禁用户 |
| sqlite 写竞争 | 房间状态更新走单条 UPDATE；高频数据（心跳）60s 节流落库；必要时把 `room_events` 留在内存环形缓冲 |
