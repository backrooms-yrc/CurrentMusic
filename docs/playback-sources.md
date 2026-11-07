# 播放音源与灰色曲目匹配

`GET /cm/ncm/song/url?id=<歌曲ID>&level=auto` 仅供已登录用户调用。
优先使用网易云 `/song/url/v1`；官方取址失败后，再调用上游文档中的
[`/song/url/match`](https://music.20110208.xyz/docs#/?id=直接获取灰色歌曲链接)。
普通可播放曲目不触发第三方匹配，不向匹配接口发送服务端或用户 Cookie。
默认匹配链包含落月公共 API 的 QQ 音源；它会通过公开歌曲资料匹配同一首录音，
再调用当前取址接口。指定档位无可用地址，或 `auto` 未选出可用档位时，自动进入此流程。
官方响应中带 `freeTrialInfo` 的片段同样视为该档位失败，不能让试听片段阻止完整音源回退；
旧版已缓存的官方地址也已更换缓存版本，避免继续复用先前接受的试听链接。

## 自动音质与杜比全景声

`GET /cm/ncm/song/url?id=2082700997&level=auto&supportsDolby=1`

- `level` 默认是 `auto`。能播放杜比的客户端可传 `supportsDolby=1`；省略或传 `0` 时按常规档位择优。
- 未设置正数 `maxBr` 时，后端在常规档位之外并行请求杜比。只有上游明确返回 `level=dolby`、提供完整音源且通过音频头校验时，杜比才优先于超清母带。上游降档或校验失败时，按常规档位的码率、格式与体积择优。
- 传入正数 `maxBr` 时按原有名义码率档位限制自动选择。指定音质档位时仍按请求取址，例如 `level=jymaster`。
- 按响应的 `level` 显示实际档位。网页依据播放器报告的 EC-3 解码能力声明支持，杜比交给系统直接输出。实际空间声效果取决于系统与音频输出设备。自动选中的杜比发生播放错误时，网页会为当前歌曲重试常规档位。

## RealIP

官方取址使用 NGINX 覆盖写入的用户 `X-Real-IP`，与搜索使用同一条可信取值链。
查询参数中的 `realIP` 不可覆盖它。音源地址、最佳档位、通用音源接口缓存均按用户 IP 隔离。
上游 `createOption()` 把 `realIP` 交给请求模块，该模块设置发往网易云的
`X-Real-IP` 与 `X-Forwarded-For`；它不会改变 TCP 连接的实际源地址。

匹配调用也带同一 `realIP` 参数，用于歌曲详情查询、缓存隔离和并发请求合并。
既有第三方音源模块接收歌曲 ID；落月 QQ 适配器使用公开歌名、歌手进行搜索，
再以匹配到的 QQ songMID 取址。它不会发送用户 IP、Bearer、服务端或用户 Cookie；
音频校验也不会向第三方发送网易云 Cookie。
这些请求仍使用服务端实际网络出口；请求头不会改变 TCP 出口。

## 匹配结果与失败

匹配器先通过 `/song/detail` 的 `dt` 取得目标歌曲时长，然后逐源检查候选地址：

1. 必须是 HTTP(S) 地址，最终响应必须能读取到音频文件头；HTML、错误页、HTTP 拒绝均被排除。
2. 用独立系统工具 `ffprobe` 读取真实音频格式与时长，不能信任音源自行声明的 `type`、`br` 或文件后缀。
3. 实际时长与 `dt` 的差值不得超过 `max(2 秒, min(10 秒, dt × 3%))`。
   这会拒绝 2.61 秒提示音、30 秒试听片段以及明显不匹配的版本；短歌曲按其实际基准判断。
4. 失败后继续检查后续音源；相同候选 URL 在一次匹配中只检查一次。

UNM 聚合源按单个原生音源分别校验，防止很短的提示音先赢得其内部的并行竞速。
缺少目标时长、`ffprobe` 不可用、网络失败或超时都会明确失败；不再将未知结果视为成功。
时长相近是完整性检查，不等于音频指纹确认；第三方匹配仍可能存在同名版本差异。

### QQ 音源自动回退

适配器根据[落月服务](https://doc.vkeys.cn/)的在线接口和
[musicdl 当前 QQ 适配源码](https://github.com/CharlesPikachu/musicdl/blob/master/musicdl/modules/sources/qq.py)
中使用的公开取址端点独立实现；不引入其源码、依赖、Cookie 或 API Key。

1. `GET https://api.vkeys.cn/v2/music/tencent?word=<歌名与歌手>` 查询公开资料。
2. 歌名和歌手集合须匹配；检查版本副标题、时长，排除翻唱、Live、伴奏、短片段。
   多个候选优先使用同专辑、时长最接近的一项。不会直接播放搜索结果的第一首。
3. 使用 `GET https://api.vkeys.cn/music/tencent/song/link?mid=<songMID>&quality=2` 取址，
   取址失败或校验不通过时立即试 `quality=1`。两档共用搜索结果与同一个检查槽位，
   另一个槽位同时尝试独立音源。候选均须通过同一套实际音频与完整时长校验。
4. `/v2/music/tencent?mid=...` 返回的播放地址可能只是试听，不能替代新版 `/music/tencent/song/link`。

2026-11-05 从部署节点实测《七里香》（网易云 ID `186001`，目标 `299000ms`）：
旧版 QQ 接口返回约 `60029ms` 试听；新版取址返回 `299352ms`、AAC/M4A、
`44100Hz`、双声道音频，通过完整时长校验。实际文件约 `48kbps`，属于降级备用音源，
不宣称原请求的无损或母带音质。服务状态、版权与账号条件变化后仍须重新校验。

成功响应保留原播放接口结构，并包含：

```json
{
  "level": "matched",
  "source": "netease-match",
  "requestedLevel": "auto",
  "br": 0,
  "hosts": []
}
```

`type`、`br`、`size`、`sr`、`bits`、`ch` 仅填写实际可验证的文件信息；未知值为空或 0。
响应还包含 `durationMs`、`expectedDurationMs`、`matchSource`。
匹配接口不保证请求的音质或 `maxBr` 上限，不能把它标成无损、母带或沉浸声。
Web 显示“匹配音源”。第三方地址不参与网易云 CDN 边缘替换。
成功结果按用户 IP 缓存 120 秒，`refresh=1` 会重新解析；失败不缓存。
原有官方音源失败缓存不会阻止匹配接口重试。

上游 `/song/url/match` 保留 `data: URL` 与 `proxyUrl` 字段，并增加 `matchInfo`：
`validated: true`、`validationVersion: 1`、实际格式与时长等。所有来源失败时返回 HTTP 502，
`reason` 和 `attempts` 仅包含错误类别、音源名及必要时长，不包含 Cookie、用户 IP 或签名 URL。
无效参数为 400、未知音源为 404、匹配进程已满为 503。

`/song/url/v1?unblock=true` 和 `/song/url/v1/302?unblock=true` 使用同一套校验；
成功前不会返回虚构的无损标记或重定向到错误页面。普通 `unblock=false` 取址沿用上游行为。
解灰按单个 ID 校验；新版接口的批量 ID 请求继续走官方批量取址，不能混作单曲匹配。

匹配进程上限 4 个，每次有 2 个候选检查槽位。单个既有音源取址期限 `2.5s`；
落月适配器含搜索与取址两次请求，各限 `3.5s`，候选总取址期限 `7.5s`。
源超时后释放检查槽位并记录 `provider_timeout`，继续后续来源；同一 URL 只校验一次。
整次匹配总期限仍为 18 秒；结束或超时会终止整个工作进程组，
包括仍在运行的探测工具。CurrentMusic 给这条慢路径预留 20 秒上游期限，其余普通取址仍保持原期限。
CurrentMusic 取址失败时记录歌曲 ID、请求档位、官方与匹配阶段耗时及允许记录的错误码。
日志只记录这些诊断字段，不包含用户 IP、Cookie 或音频 URL。

## 部署与回归

上游须已经安装它自身声明的 `unblockmusic-utils` 和 UNM 依赖；在上游节点安装系统 FFmpeg/ffprobe。
本仓库不复制这些依赖的源码或二进制。Node.js 22 是本机验证环境。

```bash
python3 tools/install-ncm-matcher.py --upstream /opt/ncm-api
python3 tools/install-ncm-matcher.py --upstream /opt/ncm-api --check
systemctl restart ncm-api
```

安装器给 4 个上游文件添加可重复安装的尾部挂钩；原始源码保存在被 Git 忽略的
`data/ncm-matcher-backups/`。上游更新或重新安装依赖后，应重新运行安装器和回归。
可在上游服务的环境中设置 `CM_FFPROBE` 指定系统工具路径；必要时用
`CM_NCM_MATCH_REFERENCE_BASE` 指定同一上游实例的回环地址，默认使用该服务的 `PORT`。

可选环境变量 `CM_NCM_MATCH_SOURCE` 指定上游支持的**单个**音源名；留空自动尝试
落月 QQ 与既有来源。`vkeys` 仅使用新版 QQ 适配器；`unm` 仅使用原生 UNM 来源。
上游原始接口同样支持 `source=vkeys`，并返回如 `matchInfo.source=vkeys:qq:2`。
不支持的音源、上游网络或服务故障仍会失败，此时返回可重试错误，不把未知原因直接判作版权限制。

验证：`node tools/test-ncm-matcher.cjs`、`tools/run-tests.sh -p test_playback_sources.py`、
`tools/run-tests.sh -p test_ncm_matcher_install.py`。测试音频由代码合成，后端测试均使用临时数据库。

## 文档核查结论

已核查[上游完整文档](https://music.20110208.xyz/docs)，其中与本修复相关的约定包括：

| 接口/约定 | 在本修复中的用途 |
| --- | --- |
| `/song/detail` 的 `dt` | 目标曲目的时长基准；`fee=0` 同时可能表示免费或无版权，不能用作成功条件 |
| `/song/url`、`/song/url/v1` | 官方取址与试听字段；取得 URL 后仍需检查实际内容 |
| `/song/download/url`、`/song/download/url/v1` | 可能与试听权限不同；302 原实现已先后尝试下载与播放路径 |
| `/song/url/match` | `source` 指定单个音源；保持字符串 URL 响应兼容 |
| `/song/music/detail` | 音质、文件大小等资料不是当前候选可播放的证明 |
| `/check/music` | 官方可用性提示不能替代第三方候选内容校验 |
| `/song/copyright/rcmd` | 返回其他版本推荐，不把翻唱静默替换成原版 |
| 云盘相关接口 | 属于用户账号内容，不用私人文件或上传/导入操作兜底公共解灰 |
| 两分钟上游缓存 | 首次重试携带时间戳；失败响应不作为成功缓存 |
