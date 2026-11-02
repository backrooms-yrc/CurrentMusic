# CurrentMusic × 网易云 API Enhanced 五阶段功能迭代计划

> **修订版 v2（基于对运行系统的实测探查）**。v1 只扫了仓库源码，遗漏了**部署层已有的通用注入代理**，导致分母、基线、阶段一设计三处错误。本版所有数字均来自实测，并可用 §10.B 的命令复现。
>
> 依据：线上文档 `https://music.example.com/docs`；运行实例 `api-enhanced v4.40.1`（`/opt/ncm-api`，`module/` 440 个模块）
> 附件：[`api-endpoint-phase-map.csv`](api-endpoint-phase-map.csv)（**440 条实测路由** → 阶段/状态 全量映射）

---

## 0. v1 的三处错误（本次探查纠正）

| # | v1 的错误 | 实测事实 |
|---|---|---|
| 1 | 分母取文档的 **399** | 运行实例实现 **440** 条路由：文档有 5 条并未实现，另有 **46 条已实现但文档未收录** |
| 2 | 基线 **29/399 = 7.3%**（把"项目覆盖"等同于"仓库源码里出现过"） | 基线应为 **31/440 = 7.0%**：29 条来自 `cm_ncm.py`，另 2 条由 cookie 自动化脚本调用 |
| 3 | **阶段一提议"从零建统一网关"** | **通用网关早已存在**：`ncm-inject`(127.0.0.1:3003) 已把全部 440 条路由带 SVIP 注入、限速、公开暴露在域名根路径。原阶段一属**重复建设** |

> 根因：v1 只 grep 了 `/opt/currentmusic`，没看 `systemctl`、没看 nginx 的 `location /`、没看 `/opt/ncm-api`。**项目的能力不等于仓库里的代码。**

---

## 1. 实测拓扑

```
公网 https://music.example.com
│
├── location ^~ /cm/       → 127.0.0.1:3010  cm-server（自建账号/歌单/听歌房/投屏/挂件/帖子）
│   ├── /cm/live/ → 3010/rooms/   听歌房 SSE
│   └── /cm/cast/ → 3010/cast/    投屏音频中转（proxy_buffering off）
│
└── location ^~ /          → 127.0.0.1:3003  ★ ncm-inject：通用透传 + SVIP 注入
                                   └→ 127.0.0.1:3001  api-enhanced v4.40.1（440 路由）

另有 127.0.0.1:3002 ncm-webui（扫码登录/状态）
定时 refresh-cookie.sh → /login/refresh ；qr-watch.py → /login/qr/{key,create,check}
```

**关键事实**：域名根路径直连通用代理，因此 **`https://music.example.com/<任意上游路径>` 现在就能用**，覆盖全部 440 条路由，并按 cookie 文件 mtime 自动跟随每日 SVIP 轮换。

`ncm-inject` 的能力边界（决定后续设计）：

| 维度 | 实测值 |
|---|---|
| 透传范围 | **全部路径**，无白名单 |
| SVIP 注入白名单 | 仅 `/song/`、`/search`、`/cloudsearch`、`/lyric` 四个前缀 |
| 调用方自带 cookie | 尊重（存在 `cookie` 参数则不注入） |
| 限速 | **120 次/分钟/IP**（实测：无参探测 285 次 → 173 次 429） |
| 鉴权 | 无（公开） |
| 错误归一 | 无（上游 502 直接透出） |

### 1.1 只读端点健康探测

对 285 条**只读**端点（按名称排除一切写操作与账号资产操作）发起无参 GET，并对被限速者按 1.6 req/s 重试：

| HTTP | 条数 | 含义 |
|---|---|---|
| 200 | **180** | 无参即可返回数据 |
| 301 | 51 | 需登录态（预期；通用代理不注入账号 cookie） |
| 502 | 33 | 强依赖参数 / 冷查询超时 / 上游失败 |
| 404 | 10 | 缺必填参数（如 `/song/detail`、`/playlist/track/all`），非缺陷 |
| 500/400/401/403/457 | 11 | 参数缺失或风控 |

> **基础能力确实成熟**：无参状态下六成只读端点直接可用，其余绝大多数是"缺参数 / 缺登录态"，而非未实现。后续重点因此在**产品化**，不在打通链路。

---

## 2. 分母校准：440 而非 399

路由由 `module/*.js` 文件名生成（`_`→`/`，`special` 覆盖 3 例）：

| 集合 | 条数 |
|---|---|
| 运行实例已实现 | **440** |
| 文档收录 | 399 |
| 交集 | 394 |
| 已实现未收录 | **46**（如 `/comment/add`、`/login/refresh`、`/msg/private/history`、`/fanscenter/*`、`/rep/ugc/exam/*`、`/album/songsaleboard`） |
| 文档有但未实现 | **5**：`/album_songsaleboard`→实为 `/album/songsaleboard`、`/vip/task/v1`→实为 `/vip/tasks/v1`、`/yunbei/tasks/{expense,receipt}`→实为 `/yunbei/{expense,receipt}`、`/comment/hotwall/list`（官方下架） |

**口径**：以运行实例的 **440** 为分母。只按文档 399 规划会漏掉 46 条能力，并把 5 条不存在的能力写进承诺。

---

## 3. 覆盖口径与三层基线

「已覆盖」= 同时满足 A（后端稳定入口：鉴权分级 + cookie 策略 + 参数规范化 + 错误归一）、B（前端有可达入口，**或被自动化流程调用**）、C（CI 契约测试）。

> 不采用"能透传即算覆盖"——那样第一天就是 100%，计划失去意义。

| 层 | 定义 | 实测 | 状态 |
|---|---|---|---|
| **L0 可达层** | 公网能调到 | **440/440 = 100%** | ✅ 已由 `ncm-inject` 交付，**本计划不再投入** |
| **L1 封装层** | 经 cm-server 有鉴权/归一/缓存/限流，或由项目专用入口直接实现 | **29/440 = 6.6%** | 待补 |
| **L2 产品层** | App/Web 有入口或自动化调用 | **31/440 = 7.0%** | 计划主体 |

L1 的 29 条（`cm_ncm.py` 实测）：
`/album` `/artist/album` `/artist/songs` `/artist/sub` `/artist/sublist` `/artists` `/captcha/sent` `/captcha/verify` `/cloudsearch` `/comment` `/comment/floor` `/comment/like` `/comment/music` `/like` `/likelist` `/login/cellphone` `/login/qr/check` `/login/qr/create` `/login/qr/key` `/lyric` `/lyric/new` `/playlist/detail` `/playlist/track/all` `/recommend/songs` `/search/hot` `/song/detail` `/song/url/v1` `/user/account` `/user/playlist`

L2 另有 2 条由自动化脚本覆盖：`/login/refresh`（`refresh-cookie.sh`）、`/login/status`（`webui.py`）→ **31 条**。

**本计划目标 = 把 L2 从 31 提到 ≥419（95%）**；L0 不动。

---

## 4. 架构决策：复用已有的，只补缺的

### 4.1 不做的事

- ❌ 不新建通用网关（`ncm-inject` 已是）
- ❌ 不重写 SVIP 注入（已有且自动跟随轮换）
- ❌ 不重做限速（已有 120/min/IP）
- ❌ 不让 App 直连根路径（见 §4.3）

### 4.2 要做的事：给 cm-server 加「登记式封装层」

```
App/Web ──Bearer token──> cm-server:3010 ──cookie/参数已配好──> api-enhanced:3001
                              ├─ cm_ncm_registry.py  路由登记表（path / tier / ttl / 裁剪规则）
                              ├─ 参数规范化（timestamp / randomCNIP / realIP / ua）
                              ├─ 错误归一（301→401 NCM_NOT_BOUND，503→429，超时→502）
                              └─ 分类 TTL 缓存 + 按接口族熔断
```

**cm-server 继续走 3001，不改指 3003**：3003 的 120/min/IP 会与公网用户共享 127.0.0.1 桶，且无鉴权、无错误归一。两者定位不同——3003 是"对外开放的裸 API"，cm-server 是"App 的受控后端"。

### 4.3 安全边界

`cm_ncm.call()` 默认 `with_cookie=True`——**每条经 cm-server 的上游调用都注入服务端 SVIP cookie**。因此新增任何"可传任意路径"的公网转发端点，都会把该 SVIP 账号的身份与私人数据（`/user/account`、`/user/playlist`、`/msg/private`、`/user/cloud`）暴露出去。

| Tier | cookie 策略 | 例 |
|---|---|---|
| T0 公开只读 | SVIP 档，**响应剥离 `uid/nickname/avatar/vipType/account`** | `/toplist`、`/song/url/v1` |
| T1 账号态只读 | 用户自己的 ncmbind cookie | `/likelist`、`/record/recent/song` |
| T2 账号态写 | 用户 cookie + 二次确认 + 审计 | `/like`、`/comment`、`/playlist/create` |
| T3 风控/会话（**禁止泛化透传**） | 仅项目专用入口；`ncmbind` 与自动化已实现 | `/login/*`、`/captcha/*`、`/register/*`、`/rebind` |

> 现有 `ncm-inject` 的注入白名单只覆盖 `/song/`、`/search`、`/cloudsearch`、`/lyric`，这四类不含身份字段，**当前无泄露**。风险出现在"把白名单扩到账号域"的扩展期——故该策略是**新增能力的前置约束**。

---

## 5. 五阶段计划

**覆盖爬升（去重后的真实累计）**

| 阶段 | 主题 | 小计 | 新增 | 累计 | 占 440 |
|---|---|---|---|---|---|
| 基线 | — | — | — | 31 | 7.0% |
| **P1** | 登记式封装层 + 发现与搜索 | 39 | 36 | **67** | 15.2% |
| **P2** | 播放内核与歌曲深度 | 70 | 60 | **127** | 28.9% |
| **P3** | 内容库：歌单/专辑/歌手/MV | 90 | 82 | **209** | 47.5% |
| **P4** | 账号、社交与听歌足迹 | 92 | 82 | **291** | 66.1% |
| **P5** | 音频生态与增值长尾（含长尾工具类 4 条） | 131 | 131 | **422** | **95.9%** |

> **实施进度（2026-09-30 · 接手后更新）**：**P4 已开启**（`ENABLED_PHASE=4`，A 层 198 → 278；契约测试 `test_ncm_registry_p4.py` 已就位）。**P4 已完成 82/92**（余 10 条 T3 见 §5.7）。**P5 已开启**（`ENABLED_PHASE=5`，A 层 280 → 411；契约测试 `test_ncm_registry_p5.py` 已就位，C 层覆盖到全量 421）。**P5 已完成 131/131（缺口 0）**。**P1–P5 全部收口，A 层 = 421/421**：
> - 电台簇 `pages/radio.js`（推荐/分类/榜单/我的订阅/数字电台五个 TAB + 电台详情与节目详情）；
> - 云小编/审核 `pages/rep.js`（权益 `/rep/ugc/user/{get,vip,collect-vip,sign}`、活动 `/rep/ugc/activity/{get,collect}`、考核四步 `/rep/ugc/exam/{start,info/get,question/single/get,submit,result/get}`、抽奖 `/middle/play/lottery/remain/chance` 与 `/middle/play/do/lottery`、审核 `/thinktank/audit/resource/{detail,update}`）；
> - 服务工具箱 `pages/services.js`（助眠 `/sati/{tag/list,resource/list,resource/list/more,resource/sub,resource/sub/list,timescene/resources/get}`、话题热榜 `/hot/topic`、上游版本 `/inner/version`、创作者认证 `/creator/authinfo/get`、权益门槛 `/threshold/detail/get`、评论摘要位 `/starpick/comments/summary`、行政区划 `/lbs/city/code`、验证二维码 `/verify/{getQr,qrcodestatus}`、批量请求 `/batch`）；
> - 会员/云贝/音乐人/粉丝/广告 `pages/member.js`（会员 `/vip/info{,/v2}`·成长值 `/vip/growthpoint{,/details,/get,/getall}`·任务 `/vip/tasks{,/v1}`·时光机 `/vip/timemachine`·乐签 `/vip/sign{,/info,/detail,/history}`；云贝 `/yunbei{,/info,/today,/expense,/receipt}`·任务 `/yunbei/tasks{,/todo}`·`/yunbei/task/list/v1`·`/yunbei/task/recommend/song`·`/yunbei/task/finish{,/v1}`·`/yunbei/sign`·推歌 `/yunbei/rcmd/song{,/history}`；音乐人 `/musician/cloudbean{,/obtain}`·`/musician/data/overview`·`/musician/play/trend`·`/musician/tasks{,/new}`·`/musician/vip/tasks`·`/musician/sign`；粉丝中心 `/fanscenter/basicinfo/{age,gender,province}/get`·`/fanscenter/overview/get`·`/fanscenter/trend/list`；广告 `/ad/get`·`/ad/listening/rights{,/gain}`）；
> - 播客/广播/私人 FM `pages/podcast.js`（私人 FM 四种模式 `/personal/fm/mode` + 场景推荐 `/aidj/content/rcmd` + 运动电台 `/radio/sport/get` + 智能续播 `/playmode/intelligence/list` + 垃圾桶 `/fm_trash`；我的播客 `/voicelist/my/created`·`/voicelist/detail`·`/voicelist/list` + 声音 `/voice/detail`·`/voice/lyric`·`/voice/upload`·`/voice/delete` + 转文字 `/voicelist/trans`；播客发现 `/voicelist/search`·`/voicelist/list/search`·`/program/recommend`；广播 `/broadcast/category/region/get`·`/broadcast/channel/list`·`/broadcast/channel/currentinfo`·`/broadcast/channel/collect/list`·`/broadcast/sub`）。
> - 听歌足迹 `pages/footprint.js`（累计时长/周报/实时统计/播放排行/逐年报告 + 六类最近播放 + 历史日推 + 我的·收藏·创建歌单 + 播放记录）；
> - 消息与私信 `pages/messages.js`（会话列表 + 聊天抽屉：读 `/msg/private/history`、写 `/send/{text,song,album,playlist}`，加评论我的 / 通知 / 转发我的 / 最近联系人 / 未读数 `/pl/count`）；
> - 关注与用户状态 `pages/follow.js`（我关注 / 粉丝 / 混合关注流 + 昵称查用户 + 是否互关 + 关注取关 + 用户状态读改与推荐）；
> - 动态与话题 `pages/events.js`（动态广场 `/event` 分页 + 话题详情 `/topic/detail` 与热动态 `/topic/detail/event/hot` 抽屉 + 我订阅的话题 `/topic/sublist` + 我的动态 `/user/event{,/all}` + 评论历史 `/user/comment/history`；卡片上可评论（复用通用评论抽屉，type=6 动态）、转发 `/event/forward`、删除 `/event/del`、改可见性 `/event/privacy`）；
> - 账号资料 / 签到 / 设备 `pages/account.js`（`/user/account`、`/user/detail`、`/user/detail/new`、`/user/level`、`/user/medal`、`/user/subcount`、`/user/binding`、`/nickname/check`、`/cellphone/existence/check`；写 `/user/update`、`/activate/init/profile`、`/avatar/upload`（复用上传通道）；签到 `/sign/happy/info` + `/signin/progress` + `/daily_signin`；设备 `/device/list` + `/device/kickoff` + `/deviceinfo/center/upload`）；
> - 云盘与电台 `pages/cloud.js`（`/user/cloud` 列表含容量、`/user/cloud/detail`、`/user/cloud/del`、`/song/cloud/download`、`/cloud/lyric/get`、`/cloud/match`、`/user/dj`、`/user/audio`）；
> - **T3 专用入口**：新增 `/ncmbind/live`（上游 `/login/status`，绑定 cookie 的权威有效性判据，失效即标记 stale）与 `/ncmbind/refresh`（上游 `/login/refresh`，一键续期）；绑定卡片上多了「检查登录态 / 刷新登录态」两个按钮。这两条正是 §5.7 说的「T3 只能走专用入口」。**P1 已完成**（39/39，缺口 0）。**P2 已完成 58/69**（剩余云盘族 7 条随 P4 做，另有 4 条永久缺口见下）。**P3 已完成 90/90（缺口 0）**——`/playlist/cover/update` 用新增的 multipart 上传通道接通。
> P3 本轮补齐的三个内容域与入口：
> - **MV / 视频**：`pages/mv.js`（详情 + 列表 + 相似 + 收藏）、`pages/video.js`（详情 + 广场 + 分类）、`web/src/mlog.js`（MLOG 播放抽屉，MV 与歌手页共用）。
> - **歌手**：`pages/artist.js` 扩展（简介/资料/动态/关注数/粉丝榜/热门作品/MV/视频/相似歌手）、新增 `pages/artists.js`（`/artist/list` 类型×地区×首字母）、`pages/followed.js` 增新歌/新MV/综合流。
> - **歌单 / 专辑 / 百科**：`playlist-edit.js`（12 条 T2 写接口收进一个编辑器抽屉）、`pages/plaza.js`（歌单广场）、`pages/albums.js`（新碟 + 数字专辑）、`pages/ugc.js`（我的百科贡献 + 词条查询）。
> 验证：`tools/ncm-smoke.py --phase 5` 共 385 项（阶段 1–5）全绿（含 multipart 上传与 POST 体用例；工具带 `--delay` 节流 + 429 重试。冒烟本轮抓到两个真问题：① 登记表改成 `ENABLED_PHASE=5` 后**没重启**服务，30 条电台接口全部 404「未知接口」—— 正好证明阶段闸门是硬闸门；② `/dj/program/detail` 的参数是**节目 id** 而不是 `mainSong.id`，传歌曲 id 上游会 404）；覆盖率 A 421 · B 420 · C 421 · A∧B∧C **420/421（99.8%）**= **420/440（95.5%）≥ 验收线 419/440**。唯一未覆盖项是 `/audio/match`（§5.8 说明：需 shazam_v2 音频指纹，客户端无法生成）。
> 这一簇的渲染策略写在了 `pages/member.js` 顶部：已知字段做专门卡片，**未知结构用 `kvHTML()` 如实摊平**，不猜字段名——猜错字段比不显示更糟（用户会以为自己的数据错了）。
> 上游降级项：`/broadcast/channel/currentinfo` 对在架的电台也返回「广播电台已下架」（该功能上游已停用）→ 页面把上游文案原样转达；`/voicelist/detail`、`/voicelist/list` 上游**限定 owner**（「只允许操作自己的播客」）→ 这两个接口只做进「我的播客」，播客发现页不做假入口。
> 度量修正一处：`/record/recent/{song,playlist,album,dj,video,voice}` 原先用模板串拼路径（`` `/record/recent/${kind}` ``），覆盖率工具认不出具体路径 → 已把六条路径**逐条写死**。拼接路径既让工具无法核对前端到底调了哪几个接口，也让「新增类型忘了补路径」这类改动不可见。
### 5.8 达标口径说明（420/421，为什么只剩一条）

**结果**：A∧B∧C = **420/421（99.8%）= 420/440（95.5%）**，验收线 ≥419/440 = 95.2% **已满足**。
分母没有动过（631 行映射表里 19 条 EXCL 是接手前就定好的，本轮一条都没改），
唯一没覆盖的 `/audio/match` **也仍然留在分母里**。

| 缺口 | 条数 | 说明 |
|---|---|---|
| `/audio/match` | 1 | 需 shazam_v2 音频指纹，客户端生成不了（源码级事实，非"做不动"）。**没有把它挪进 EXCL 来凑数字**——留着分母才说明 95.5% 是真数 |

补齐路径（本轮新增）：
- **T3 专用入口 10 条**：`_T3_ROUTES` 表实现 `/logout`、`/setting`、`/captcha/{sent/v1,safe/sent}`、
  `/login`、`/rebind`、`/user/{bindingcellphone,replacephone}`、`/register/{anonimous,cellphone}`；
  统一走「项目 Bearer 鉴权 → 绑定校验（需要的才要）→ 写操作 confirm=1 → 审计日志」，
  **不经泛化转发**（T3 在网关里依旧 403）。前端入口在绑定卡片的「高级操作」抽屉里，
  每条都先说明再确认。契约测试 `test_ncm_t3_routes.py`（7 项）钉死「T3 全覆盖」「不得指向非 T3 上游」
  「必须先鉴权」「写必须二次确认 + 审计」「绝不用 SVIP 档兜底」。
- **P2 云盘上传 4 条**：`/cloud`（旧接口，经服务端 multipart）+ `/cloud/upload/{token,complete}`
  三步直传（前端**自带 MD5**，因为 WebCrypto 只有 SHA 系列）+ `/cloud/import` 补救入库。
  直传要跨域放行，被拦时页面明确让用户改走旧接口，不假装成功。
- **P2 零头 3 条**：`/resource/like`（MV 点赞）、`/playmode/song/vector`（歌曲向量相似度）、
  `/song/url/v1/302`。

### 5.9 三条「能算覆盖但不能走 JSON 网关」的接口（如实记录）

| 接口 | 上游实际返回 | 处理方式 |
|---|---|---|
| `/song/url/v1/302` | **裸音频流**（body 以 `ID3` 开头，不是 JSON） | 前端不当 JSON 调，改用站点根路径的通用代理地址直接播/复制 |
| `/verify/getQr`、`/verify/qrcodestatus` | 无风控下发的 evid/sign/token 时回 404/500 | 页面只做手动带入，不伪造风控参数；冒烟接受 200 或 502 |
| `/summary/annual` | 404「接口未找到」（已下线） | 年度维度改用 `/listen/data/year/report` |

> 上游降级项：`/summary/annual` 实测 404（年度总结接口已下线）→ 年度维度改用 `/listen/data/year/report`，页面明确标注。
> 上游降级项：`/verify/getQr`、`/verify/qrcodestatus` 在没有风控下发的 `evid/sign/token` 时分别回 404 / 500 —— 页面只做手动带入与状态轮询，**不伪造风控参数**，冒烟按「200 或 502」双结果接受。
>
> **接手时修掉的两件事**（原会话已损坏，根因与修复记录见 [`session-recovery-2026-09-30.md`](session-recovery-2026-09-30.md)）：
> ① **分支与 main 分叉**：`feat/ncm-registry-p1` 自 `0dc8193` 分出后，main 上落了波形指示器一整套改动（#13–#19）。两者都改播放器 → 已把 main 合入分支（`bindAudio(el)` 结构保留，听歌打卡并进其中的 `timeupdate`），构建产物按源码重建。
> ② **三处参数名踩坑（都已钉进冒烟用例）**：
>    - `/video/detail` 上游读 `id`，而 `/video/detail/info` 读 `vid` —— 传错会把 502 误判成「上游挂了」（曾据此写下错误的降级结论，已纠正）；
>    - `/album/detail`、`/album/list/style` 是**数字专辑**（vipmall）接口，`id` 必须来自 `/album/list` 的 `albumId`，传音乐专辑 id 会 404；
>    - `/album/songsaleboard` 的 `type` 只认 `daily/week/year/total`，写 `yearly` 会 404；只有 `year` 需要 `year` 参数。
>
> **上游已知降级项**（有入口、有降级表现，数字上算覆盖但如实标注）：
> - `/video/group` 恒返回 `code=200, datas=null`（分类页显示明确空态）；
> - `/simi/playlist`、`/simi/user` 在当前账号下恒返回空数组（区块按空隐藏）；
> - `/video/detail` 在个别 vid 上会 502 → 详情页降级为「可播放 + 计数 + 评论」，不阻塞整页。
>
> **文件上传通道（本轮新增，`/playlist/cover/update` 由此接通，P4 的 `/avatar/upload`、P5 的 `/voice/upload` 直接复用）**：
> 泛化转发原本只吃 query/JSON，而这三个接口要 `multipart/form-data` 里的文件。做法是加一条**白名单**通道，而不是放开任意上传：
>   1. `cm_ncm_gateway.UPLOAD_FIELD` 只列了会用到文件的路径（未登记路径**即使带 `file` 也当普通 JSON**，不会被当成上传）；
>   2. `decode_upload()` 做类型白名单（图片/音频 MIME）、体积上限（解码前按 base64 长度先挡一次，避免超大串吃内存）、base64 合法性三类校验，任一不过 → 400；
>   3. 门禁顺序不变：登记表 → 阶段 → **T2 需绑定 + `confirm=1` + 审计**，未绑定在解码文件**之前**就被拦掉；
>   4. `normalize_params` 把 `confirm`/`file` 列入保留参数剥离，文件字节只走 body，绝不进 URL。
> 前端 `api.ncmUpload()` 会先用 canvas 把图压到最长边 1024 再 base64 提交（服务端请求体上限 2MB，手机原图必超）。
> 契约测试 `backend/tests/test_ncm_upload.py`（12 项）钉死白名单/类型/体积/base64/保留参数五类不变量。
>
> **顺手修掉一个会让所有 T1/T2 调用必 401 的真 bug**：前端 `api.ncm()` 从来没带 `Authorization`，而网关的 T1/T2 分级要拿调用者自己的 ncmbind cookie——于是「收藏专辑」「收藏 MV」「歌单改名/加歌/排序」「曲风偏好」「资产页」这些账号态功能在**已绑定**时也一律返回「未登录」。现已统一带上 Bearer，并把 401 的两种来源分开：会话失效才提示「登录已失效」，未绑定则引导去绑定（原先按状态码一律当会话失效）。实测：同一请求无 token →「未登录」；带 token →「请先绑定网易云账号后再使用该功能」。
> **P2 剩余**：云盘族 7 条（`/cloud*`、`/song/cloud/download`）——与 P4 的 `/user/cloud` 列表强耦合，计划随 P4 一起做。
> 分母校准：运行实例 440 条，其中 **19 条不采用**（产品决策，见 `api-endpoint-phase-map.csv` 的 `EXCL`）= **目标集 421**，上限 421/440 = **95.7%**，验收线 ≥419/440。
> 验收线 ≥419/440 = 95%；目标集 422，上限 **95.9%**（18 条排除见 §5.6）。下表所有接口路径均已与 440 条实测路由逐条核对。

### 阶段一（P1）：登记式封装层 + 发现与搜索（小计 39，新增 36）✅ 已完成

**目标**：不建网关，只给 cm-server 加登记表与安全分级（L1 从 29 → ~74），同时让「发现页」吃满搜索/推荐/榜单。

> **分级实况（生成器判定，实施时纠正）**：45 条中 **42 条 T0 公开只读 + 2 条 T1 账号只读**（`/recommend/resource`、`/recommend/songs`——每日推荐是账号维度数据，必须用调用者自己的 cookie，不能走 SVIP 档）**+ 1 条 T2 写**（`/recommend/songs/dislike`，需 `confirm=1`）。原计划把 P1 整组视作公开只读，实测该组含 1 写 2 账号读，已按 §4.3 纠正。

| 归类 | 条数 | 接口 |
|---|---|---|
| 搜索 | 9 | `/cloudsearch` `/search` `/search/default` `/search/hot` `/search/hot/detail` `/search/match` `/search/multimatch` `/search/suggest` `/search/suggest/pc` |
| 首页与推荐 | 12 | `/banner` `/homepage/block/page` `/homepage/dragon/ball` `/personalized` `/personalized/djprogram` `/personalized/mv` `/personalized/newsong` `/personalized/privatecontent` `/personalized/privatecontent/list` `/recommend/resource` `/recommend/songs` `/recommend/songs/dislike` |
| 榜单 | 11 | `/top/album` `/top/artists` `/top/list` `/top/mv` `/top/playlist` `/top/playlist/highquality` `/top/song` `/toplist` `/toplist/artist` `/toplist/detail` `/toplist/detail/v2` |
| 曲风 | 7 | `/style/album` `/style/artist` `/style/detail` `/style/list` `/style/playlist` `/style/preference` `/style/song` |
| 图表与工具 | 5 | `/batch` `/chart/detail` `/chart/song/detail` `/countries/code/list` `/lbs/city/code` |
| 日历 | 1 | `/calendar` |
| **合计** | **45** | — |

**后端**：新增 `backend/cm_ncm_registry.py`（登记表 + 分级 + 参数规范化 + 错误归一 + 按族熔断），`cm_server.py` 末端接统一分发；复用 `cm_db.cache_get/set` 做分类 TTL。
**前端**：`api.js` 增 `api.ncm(path, params)` 通用方法；改造 `pages/square.js`（推荐歌单/新歌/独家放送/Banner/曲风/榜单）、`pages/search.js`（热搜详情、建议防抖、默认关键词）。
**验收**：45 条经 Bearer 保护可 `curl` 通；未登记路径 404；T0 响应确认无身份字段；覆盖率 73/440（16.6%）。
**预估**：10–12 人日，3–4 PR。

### 阶段二（P2）：播放内核与歌曲深度（小计 70，新增 60）

| 归类 | 条数 | 接口 |
|---|---|---|
| 歌曲与音源 | 29 | `/song/chorus` `/song/cloud/download` `/song/copyright/rcmd` `/song/creators` `/song/detail` `/song/downlist` `/song/download/url` `/song/download/url/v1` `/song/dynamic/cover` `/song/like` `/song/like/check` `/song/lyrics/mark` `/song/lyrics/mark/add` `/song/lyrics/mark/del` `/song/lyrics/mark/user/page` `/song/monthdownlist` `/song/music/detail` `/song/order/update` `/song/purchased` `/song/red/count` `/song/simi/get` `/song/singledownlist` `/song/url` `/song/url/match` `/song/url/ncmget` `/song/url/v1` `/song/url/v1/302` `/song/wiki/info` `/song/wiki/summary` |
| 评论 | 18 | `/comment` `/comment/add` `/comment/album` `/comment/delete` `/comment/dj` `/comment/event` `/comment/floor` `/comment/hot` `/comment/hug/list` `/comment/info/list` `/comment/like` `/comment/music` `/comment/mv` `/comment/new` `/comment/playlist` `/comment/reply` `/comment/report` `/comment/video` |
| 云盘 | 6 | `/cloud` `/cloud/import` `/cloud/lyric/get` `/cloud/match` `/cloud/upload/complete` `/cloud/upload/token` |
| 歌词 | 2 | `/lyric` `/lyric/new` |
| 打卡·喜欢·乐谱 | 6 | `/like` `/like/v1` `/scrobble` `/scrobble/v1` `/sheet/list` `/sheet/preview` |
| 其它 | 9 | `/audio/match` `/check/music` `/hug/comment` `/likelist` `/music/first/listen/info` `/playmode/song/vector` `/relay/play/state/submit` `/resource/like` `/share/resource` |
| **合计** | **70** | — |

**后端**：音频族复用 `best_level()` 与档位缓存；评论族抽 `comment_list(type,id)` 覆盖六维度；云盘上传走上游 token 直传（不经本服务）。
**前端**：`player-ui.js` 加歌词摘录/歌词本与真实档位面板；新增 `comment.js`（六维度通用评论抽屉）、`pages/cloud.js`、`pages/identify.js`（识曲）、`pages/songwiki.js`；`/scrobble` 接入播放器。
**数据**：`song_marks`、`scrobble_queue`（离线补报）、`cloud_files`。
**验收**：播放自动产生 `/scrobble` 并计入时长；云盘上传→匹配→播放真机通过；覆盖率 133/440（30.2%）。
**预估**：14–17 人日，5 PR。

### 阶段三（P3）：内容库（小计 90，新增 82）

| 归类 | 条数 | 接口 |
|---|---|---|
| 歌单 | 27 | `/playlist/category/list` `/playlist/catlist` `/playlist/cover/update` `/playlist/create` `/playlist/delete` `/playlist/desc/update` `/playlist/detail` `/playlist/detail/dynamic` `/playlist/detail/rcmd/get` `/playlist/highquality/tags` `/playlist/hot` `/playlist/import/name/task/create` `/playlist/import/task/status` `/playlist/mylike` `/playlist/name/update` `/playlist/order/update` `/playlist/privacy` `/playlist/subscribe` `/playlist/subscribers` `/playlist/tags/update` `/playlist/track/add` `/playlist/track/all` `/playlist/track/delete` `/playlist/tracks` `/playlist/update` `/playlist/update/playcount` `/playlist/video/recent` |
| 专辑 | 11 | `/album` `/album/detail` `/album/detail/dynamic` `/album/list` `/album/list/style` `/album/new` `/album/newest` `/album/privilege` `/album/songsaleboard` `/album/sub` `/album/sublist` |
| 歌手 | 18 | `/artist/album` `/artist/desc` `/artist/detail` `/artist/detail/dynamic` `/artist/fans` `/artist/follow/count` `/artist/list` `/artist/mv` `/artist/new/mv` `/artist/new/song` `/artist/new/song/mv/list/v2` `/artist/new/song/playall` `/artist/songs` `/artist/sub` `/artist/sublist` `/artist/top/song` `/artist/video` `/artists` |
| MV·视频·相似·MLOG | 27 | `/mlog/music/rcmd` `/mlog/to/video` `/mlog/url` `/mv/all` `/mv/detail` `/mv/detail/info` `/mv/exclusive/rcmd` `/mv/first` `/mv/sub` `/mv/sublist` `/mv/url` `/related/allvideo` `/related/playlist` `/simi/artist` `/simi/mv` `/simi/playlist` `/simi/song` `/simi/user` `/video/category/list` `/video/detail` `/video/detail/info` `/video/group` `/video/group/list` `/video/sub` `/video/timeline/all` `/video/timeline/recommend` `/video/url` |
| UGC 百科 | 7 | `/ugc/album/get` `/ugc/artist/get` `/ugc/artist/search` `/ugc/detail` `/ugc/mv/get` `/ugc/song/get` `/ugc/user/devote` |
| **合计** | **90** | — |

**后端**：歌单写操作全 T2 + 用户 cookie；`/playlist/import/{name/task/create,task/status}` 两段式异步任务（新增 `import_tasks` 表 + 轮询线程）。
**前端**：`pages/library.js` 重构为五分区；`pages/playlist.js` 加编辑与导入；`pages/artist.js` 加专辑墙/MV/相似歌手/百科；新增 `pages/album.js`、`pages/video.js`（播放器 video 模式）。
**验收**：歌单创建→加歌→排序→改封面→隐私→删除全通；导入任务 pending→success；覆盖率 215/440（48.9%）。
**预估**：18–22 人日，6 PR。

### 阶段四（P4）：账号、社交与听歌足迹（小计 92，新增 82）

| 归类 | 条数 | 接口 |
|---|---|---|
| 账号资料 | 15 | `/activate/init/profile` `/avatar/upload` `/cellphone/existence/check` `/nickname/check` `/rebind` `/user/account` `/user/binding` `/user/bindingcellphone` `/user/detail` `/user/detail/new` `/user/level` `/user/medal` `/user/replacephone` `/user/subcount` `/user/update` |
| 登录·注册·验证码 | 14 | `/captcha/safe/sent` `/captcha/sent` `/captcha/sent/v1` `/captcha/verify` `/login` `/login/cellphone` `/login/qr/check` `/login/qr/create` `/login/qr/key` `/login/refresh` `/login/status` `/logout` `/register/anonimous` `/register/cellphone` |
| 关系链与社会状态 | 10 | `/follow` `/get/userids` `/user/follow/mixed` `/user/followeds` `/user/follows` `/user/mutualfollow/get` `/user/social/status` `/user/social/status/edit` `/user/social/status/rcmd` `/user/social/status/support` |
| 动态与话题 | 10 | `/event` `/event/del` `/event/forward` `/event/privacy` `/topic/detail` `/topic/detail/event/hot` `/topic/sublist` `/user/comment/history` `/user/event` `/user/event/all` |
| 消息与私信 | 12 | `/msg/comments` `/msg/forwards` `/msg/notices` `/msg/private` `/msg/private/history` `/msg/recentcontact` `/pl/count` `/send/album` `/send/playlist` `/send/song` `/send/text` `/setting` |
| 听歌足迹 | 16 | `/history/recommend/songs` `/history/recommend/songs/detail` `/listen/data/realtime/report` `/listen/data/report` `/listen/data/song/play/rank` `/listen/data/today/song` `/listen/data/total` `/listen/data/year/report` `/recent/listen/list` `/record/recent/album` `/record/recent/dj` `/record/recent/playlist` `/record/recent/song` `/record/recent/video` `/record/recent/voice` `/summary/annual` |
| 设备管理 | 3 | `/device/kickoff` `/device/list` `/deviceinfo/center/upload` |
| 用户云盘与电台 | 5 | `/user/audio` `/user/cloud` `/user/cloud/del` `/user/cloud/detail` `/user/dj` |
| 用户歌单与播放记录 | 4 | `/user/playlist` `/user/playlist/collect` `/user/playlist/create` `/user/record` |
| 签到 | 3 | `/daily_signin` `/sign/happy/info` `/signin/progress` |
| **合计** | **92** | — |

**前端**：`pages/user.js` 改版（账号卡/足迹/消息/设备）；新增 `pages/footprint.js`（周月年报告 + 年度总结出图）、`pages/messages.js`、`pages/follow.js`、`pages/event.js`。
**数据**：`ncm_msg_read`（已读游标）、`footprint_cache`；足迹与自有 `plays` 表取并集。
**验收**：关注/私信/通知真机通；总时长与自有统计误差 <1%；设备下线（T3 专用入口）需二次确认；覆盖率 297/440（67.5%）。
**预估**：17–20 人日，5–6 PR。

### 阶段五（P5）：音频生态与增值长尾（小计 131）

打包为 3 个子迭代，用聚合面板承接（不各做页面）：

| 归类 | 条数 | 接口 |
|---|---|---|
| 电台 DJ | 30 | `/dj/banner` `/dj/category/excludehot` `/dj/category/recommend` `/dj/catelist` `/dj/detail` `/dj/difm/all/style/channel` `/dj/difm/channel/subscribe` `/dj/difm/channel/unsubscribe` `/dj/difm/playing/tracks/list` `/dj/difm/subscribe/channels/get` `/dj/hot` `/dj/paygift` `/dj/personalize/recommend` `/dj/program` `/dj/program/detail` `/dj/program/toplist` `/dj/program/toplist/hours` `/dj/radio/hot` `/dj/recommend` `/dj/recommend/type` `/dj/sub` `/dj/sublist` `/dj/subscriber` `/dj/today/perfered` `/dj/toplist` `/dj/toplist/hours` `/dj/toplist/newcomer` `/dj/toplist/pay` `/dj/toplist/popular` `/djRadio/top` |
| 播客声音 | 11 | `/program/recommend` `/voice/delete` `/voice/detail` `/voice/lyric` `/voice/upload` `/voicelist/detail` `/voicelist/list` `/voicelist/list/search` `/voicelist/my/created` `/voicelist/search` `/voicelist/trans` |
| 广播电台 | 5 | `/broadcast/category/region/get` `/broadcast/channel/collect/list` `/broadcast/channel/currentinfo` `/broadcast/channel/list` `/broadcast/sub` |
| 私人 FM 与场景 | 6 | `/aidj/content/rcmd` `/fm_trash` `/personal/fm/mode` `/personal_fm` `/playmode/intelligence/list` `/radio/sport/get` |
| VIP 会员 | 13 | `/vip/growthpoint` `/vip/growthpoint/details` `/vip/growthpoint/get` `/vip/growthpoint/getall` `/vip/info` `/vip/info/v2` `/vip/sign` `/vip/sign/detail` `/vip/sign/history` `/vip/sign/info` `/vip/tasks` `/vip/tasks/v1` `/vip/timemachine` |
| 云贝 | 14 | `/yunbei` `/yunbei/expense` `/yunbei/info` `/yunbei/rcmd/song` `/yunbei/rcmd/song/history` `/yunbei/receipt` `/yunbei/sign` `/yunbei/task/finish` `/yunbei/task/finish/v1` `/yunbei/task/list/v1` `/yunbei/task/recommend/song` `/yunbei/tasks` `/yunbei/tasks/todo` `/yunbei/today` |
| 音乐人 | 8 | `/musician/cloudbean` `/musician/cloudbean/obtain` `/musician/data/overview` `/musician/play/trend` `/musician/sign` `/musician/tasks` `/musician/tasks/new` `/musician/vip/tasks` |
| 数字专辑 | 4 | `/digitalAlbum/detail` `/digitalAlbum/ordering` `/digitalAlbum/purchased` `/digitalAlbum/sales` |
| 云小编 | 15 | `/middle/play/do/lottery` `/middle/play/lottery/remain/chance` `/rep/ugc/activity/collect` `/rep/ugc/activity/get` `/rep/ugc/exam/info/get` `/rep/ugc/exam/question/single/get` `/rep/ugc/exam/result/get` `/rep/ugc/exam/start` `/rep/ugc/exam/submit` `/rep/ugc/user/collect-vip` `/rep/ugc/user/get` `/rep/ugc/user/sign` `/rep/ugc/user/vip` `/thinktank/audit/resource/detail` `/thinktank/audit/resource/update` |
| 广告权益 | 3 | `/ad/get` `/ad/listening/rights` `/ad/listening/rights/gain` |
| 粉丝中心 | 5 | `/fanscenter/basicinfo/age/get` `/fanscenter/basicinfo/gender/get` `/fanscenter/basicinfo/province/get` `/fanscenter/overview/get` `/fanscenter/trend/list` |
| 助眠解压 | 6 | `/sati/resource/list` `/sati/resource/list/more` `/sati/resource/sub` `/sati/resource/sub/list` `/sati/tag/list` `/sati/timescene/resources/get` |
| 话题热榜 | 1 | `/hot/topic` |
| 其它杂项 | 6 | `/creator/authinfo/get` `/inner/version` `/starpick/comments/summary` `/threshold/detail/get` `/verify/getQr` `/verify/qrcodestatus` |
| **合计** | **127** | — |

**P5A 电台/播客/广播**（前 4 组，52 条）→ 新页面 `pages/radio.js`、`pages/podcast.js`；**听歌房扩展为「一起听电台/播客」**（复用 `cm_rooms.py`，差异化亮点）。
**P5B 会员与增长**（VIP/云贝/音乐人/数字专辑/云小编/广告/粉丝中心，62 条）→ 新页面 `pages/vip.js`（乐签/成长值/任务）、`pages/yunbei.js`（签到/收支/推歌）、`pages/musician.js`（数据概况/趋势）；云小编与广告收进「网易云服务」工具箱卡片。
**P5C 场景与杂项**（助眠/话题热榜/其它，13 条）→ 新页面 `pages/sati.js`（助眠解压）。

**验收**：电台可订阅并加进听歌房；助眠场景可播放并记忆进度；云贝/乐签一键领取；覆盖率 **424/440（96.4%）**，`/admin/ncm` 仪表与 `tools/ncm-coverage.py` 一致。
**预估**：24–28 人日，7–8 PR。

### 5.6 排除清单（18 条 = 16 不采用 + 2 不可达）

| 接口 | 条数 | 理由 |
|---|---|---|
| `/listentogether/accept` `/listentogether/end` `/listentogether/heatbeat` `/listentogether/play/command` `/listentogether/room/check` `/listentogether/room/create` `/listentogether/status` `/listentogether/sync/list/command` `/listentogether/sync/playlist/get` | 9 | 上游「一起听」；本项目已有功能更强的自建听歌房（`cm_rooms.py`：房间广场/密码房/三级权限/点歌审批/SSE 时钟同步），接入属重复建设 |
| `/decrypt` `/eapi/decrypt` | 2 | eapi 解密工具接口，非业务功能 |
| `/api` `/weblog` | 2 | 接口调试页 / 埋点上报，无用户价值 |
| `/register/checktoken/v2` `/register/checktoken/v3` `/register/xeapikey` | 3 | 注册风控辅助 token/key，与自建账号体系无关，且属 T3 |

| `/chart/detail` `/chart/song/detail` | 2 | **不可达**：上游 api-enhanced 实测恒返回 502（该维度榜已下线），功能不存在 |

> 目标集 = 440 − 18 = **422**，上限 422/440 = **95.9%**，验收线 ≥419/440。留 3 条余量应对上游后续变动。
>
> **为什么不把「无界面场景」的接口也算成排除**：`/batch`、`/lbs/city/code`、`/search/match`、`/search/multimatch` 有真实能力，只是没有独立界面场景。把它们排除掉会让分母变小、覆盖率数字变好看——那是自欺。它们保留在分母内，**排期到 P5** 用工具箱/本地曲库/综合搜索承接。

---

### 5.7 开启阶段四、五时发现的安全与口径问题

#### (1) 阶段四审计：三条"名字像读、上游是写"的接口此前停在 T1

分级器靠路径里的动词判断读写，以下三条命不中任何写标记，被判成 **T1 账号只读**，
于是会**绕过 T2 的 `confirm=1` + 审计**被直接放行（调用者自己的 cookie，影响面限于本人，
但"写操作必须二次确认"这条策略被绕开了）：

| 接口 | 上游真实动作 | 误判后果 |
|---|---|---|
| `/daily_signin` | `POST /api/point/dailyTask` | 签到被当成读，无确认无审计 |
| `/follow` | `/api/user/follow\|delfollow/{id}` | 关注/取关同上 |
| `/activate/init/profile` | `POST /api/activate/initProfile` | 初始化昵称同上 |

已加入 `WRITE_EXACT` 并重新生成登记表，`test_ncm_registry_p4.py::test_hidden_writes_are_t2_not_t1` 钉死。
顺带把 P5 的 `/yunbei/rcmd/song`（`POST /api/yunbei/rcmd/song/submit`，要花云贝）也纠正为 T2。
另一类"上游路径含写动词、实际却是读"的 4 条（`/artist/follow/count`、`/user/follow/mixed`、
`/user/playlist/collect`、`/user/playlist/create`）也逐条查了上游：前两条是 `.../get` 结尾的查询，
后两条入参是 `limit/offset/userId` 的列表查询 —— 确认是读，保持原分级，不误伤。

#### (2) 阶段五审计：10 条"路径带写动词、其实是查询"的接口被误判成 T2

写标记（`/sign`、`/collect`、`/lottery`、`/create`…）在阶段五"过度命中"：
`/vip/sign/info`、`/voicelist/my/created`、`/middle/play/lottery/remain/chance` 这类
**查询**被判成了写。留 T2 的后果是纯查询也要 `confirm=1` 并进写审计；而如果图省事直接
降到 T0，就会用服务端 SVIP cookie 去读主账号数据 —— **两个方向都会错**，所以这 10 条
同时进 `READ_OVERRIDES`（不当写）与 `ACCOUNT_READ`（不当公开读），由
`test_ncm_registry_p5.py::test_audited_reads_are_t1_not_t2` 钉死，另有一条测试确保
`/vip/sign`、`/yunbei/sign`、`/musician/sign`、`/voice/upload` 这些**真写**没被顺带放宽。

#### (3) ≥419 这条线隐含要求「T3 也要有专用后端入口」

T3（登录/验证码/注册/换绑）**不能**经泛化转发，因此不计入 A 层，除非项目有专用入口。
当前 18 条 T3 的实况：

| 状态 | 条数 | 接口 |
|---|---|---|
| 已有专用入口（`/ncmbind/*` 直接调上游） | 6 | `/captcha/sent` `/captcha/verify` `/login/cellphone` `/login/qr/{key,create,check}` |
| 已补专用入口 | 2 | `/login/status` → `GET /ncmbind/live`（绑定有效性权威判据）、`/login/refresh` → `POST /ncmbind/refresh`（一键续期） |
| **仍无后端入口** | 10 | `/captcha/safe/sent` `/captcha/sent/v1` `/login` `/logout` `/rebind` `/register/anonimous` `/register/cellphone` `/setting` `/user/bindingcellphone` `/user/replacephone` |

其中 `/register/*`（注册网易云账号）、`/rebind` `/user/bindingcellphone` `/user/replacephone`（换绑手机）
属于**网易云账号本体**的运维操作，与本项目「自建账号 + 绑定网易云」的模型无关——
按 §5.6 的同一套理由，它们更适合走**排除**而不是硬做入口（做了也只是给用户一个危险按钮）。
`/logout`、`/setting`（消息与隐私设置）、`/captcha/sent/v1`、`/captcha/safe/sent` 则确实有产品价值，
列入 P4 收尾。**这一条要在完成目标前重新校准分母**：若这 10 条最终判为不采用，
目标集从 421 降到 411，验收线 ≥419 就**必须**回到 440 口径重算。

**结论（必须记在明面上）**：目标集 421 里有 18 条 T3，若只做前四阶段那种"网关放量"，
P4 的上限是 74/92；要够到 ≥419/440，**这 10 条必须补专用入口**（`/logout`、`/rebind`、
`/user/bindingcellphone`、`/login/status` 等本来就该有），其余 2 条自动化项要让
`tools/ncm-coverage.py` 的 A 层认下它们（工具已扩展为「登记表 + 手写 `/ncm/*` 路由 +
`backend` 里 `call("/x")` 的专用调用」三者取或，正是为此）。

## 6. 覆盖率演算与阶段门禁

| 阶段 | 小计 | 新增 | 累计覆盖 | 占 440 | 占目标集 422 |
|---|---|---|---|---|---|
| 基线 | — | — | 31 | 7.0% | 7.3% |
| P1 | 39 | 36 | 67 | 15.2% | 15.9% |
| P2 | 70 | 60 | 127 | 28.9% | 30.1% |
| P3 | 90 | 82 | 209 | 47.5% | 49.5% |
| P4 | 92 | 82 | 291 | 66.1% | 69.0% |
| **P5** | **131** | **131** | **422** | **95.9%** | **100%** |

**门禁**：① `tools/ncm-coverage.py --phase Pn` 累计 ≥ 上表；② 新增接口契约测试全绿；③ 真机回归无回退（重点：SVIP 音质、投屏、听歌房、歌单同步只读）；④ CI 四绿。

---

## 7. 测试与验收

**`tools/ncm-coverage.py`**：解析 `docs/api-endpoint-phase-map.csv`（期望 440）→ 扫 `backend/cm_ncm_registry.py`（A）→ 扫 `web/src/**/*.js` 调用点（B）→ 扫 `backend/tests/`（C）→ 输出总覆盖/分阶段/缺口清单。

**三层测试**：L1 离线 mock（每次 push）、L2 真实只读探测（每日；**必须走独立上游实例，且不得对写接口自动发请求**）、L3 真机端到端（每阶段门禁）。

> 本次探查暴露的硬约束：**公开代理限速 120/min/IP**。L2 探测必须按 ≤1.5 req/s 节流，否则会像本次一样触发 429 并污染结论。

---

## 8. 风险

| 风险 | 等级 | 对策 |
|---|---|---|
| 泛化转发泄露 SVIP 账号身份 | **高** | §4.3 四级 cookie 策略；T0 响应剥离身份字段；P1 硬性交付 + 专项测试 |
| 上游风控 / IP 高频（460 cheating） | 高 | `randomCNIP`、分类 TTL、按接口族熔断、写接口不重试 |
| 用户绑定 cookie 失效 | 高 | 统一 `401 NCM_NOT_BOUND` + 一键重绑；保留本地快照（现有设计） |
| 长尾接口上游不稳定（实测 33/285 返回 502） | 中 | 登记 `degraded` 标记，卡片级降级，不影响整页 |
| 公开代理 120/min 限速误伤 | 中 | cm-server 走 3001 而非 3003；探测与自动化节流 |
| 海外 IP 曲库限制（周杰伦等） | 中 | 已知限制，文档明示 |
| 写入类接口误操作（删歌单/删评论） | 中 | T2 二次确认 + 审计 + 软删除提示 |
| CI 产物同步（改前端必须重建提交） | 中 | 每阶段 PR 末尾 `cd web && node build.mjs` 并提交 `app/src/main/assets/www/*` |
| 默认 UI 被破坏 | 中 | 新样式限定 `html[data-ui-preset="..."]` 作用域 |
| 安卓文件选择桥（云盘/播客上传） | 中 | 走 `NativeApi` 桥（无 androidx，手写 `ACTION_GET_CONTENT`） |

---

## 9. 节奏

| 阶段 | 小计 | 新增 | PR | 人日 | 依赖 |
|---|---|---|---|---|---|
| P1 登记层 + 发现 | 45 | 42 | 3–4 | 10–12 | 无 |
| P2 播放内核 | 70 | 60 | 5 | 14–17 | P1 |
| P3 内容库 | 90 | 82 | 6 | 18–22 | P1；P2 评论组件 |
| P4 账号社交 | 92 | 82 | 5–6 | 17–20 | P1；P3 动态↔帖子 |
| P5 生态长尾 | 127 | 127 | 7–8 | 24–28 | P1–P4 |
| **合计** | **424** | **393** | **26–29** | **83–99** | |

P3 与 P4 无强依赖可并行；P5A/P5B/P5C 可并行。

---

## 10. 附录

### A. 全量映射

[`api-endpoint-phase-map.csv`](api-endpoint-phase-map.csv)：440 行，字段 `phase,path,title,status`；`status ∈ {已封装, 已自动化, 待产品化, 不采用}`，`phase=EXCL` 为不采用。

### B. 实测命令留档

```bash
systemctl status currentmusic ncm-api ncm-inject ncm-webui
ss -ltnp | grep -E "300[0-9]|3010"
nginx -T | awk '/server_name music.example.com/,/^}/' | grep -E "location|proxy_pass"
ls /opt/ncm-api/module/*.js | wc -l                 # 440
curl -s "http://127.0.0.1:3003/toplist" | head -c 200   # 通用代理已验证可用
grep -ohE '"/[a-zA-Z0-9_/.-]+"' backend/cm_ncm.py | sort -u | wc -l   # 29
```

### C. 口径速查

- **已覆盖** = A ∧ B ∧ C；**分母** = 运行实例 440；**目标** ≥95%（≥419），上限 424（96.4%）
- **三层** = L0 可达（100%，已有）/ L1 封装（29）/ L2 产品（31）
