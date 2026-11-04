# 播放音源与灰色曲目匹配

`GET /cm/ncm/song/url?id=<歌曲ID>&level=auto` 仅供已登录用户调用。
优先使用网易云 `/song/url/v1`；官方取址失败后，再调用上游文档中的
[`/song/url/match`](https://music.20110208.xyz/docs#/?id=直接获取灰色歌曲链接)。
普通可播放曲目不触发第三方匹配，不向匹配接口发送服务端或用户 Cookie。

## RealIP

官方取址使用 NGINX 覆盖写入的用户 `X-Real-IP`，与搜索使用同一条可信取值链。
查询参数中的 `realIP` 不可覆盖它。音源地址、最佳档位、通用音源接口缓存均按用户 IP 隔离。
上游 `createOption()` 把 `realIP` 交给请求模块，该模块设置发往网易云的
`X-Real-IP` 与 `X-Forwarded-For`；它不会改变 TCP 连接的实际源地址。

匹配调用也带同一 `realIP` 参数，用于歌曲详情查询、缓存隔离和并发请求合并。
第三方音源模块只接收歌曲 ID，检查音频也不会向第三方发送网易云 Cookie。
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

匹配进程上限 4 个，每次最多同时检查 2 个源，总期限 18 秒；结束或超时会终止整个工作进程组，
包括仍在运行的探测工具。CurrentMusic 给这条慢路径预留 20 秒上游期限，其余普通取址仍保持原期限。

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

可选环境变量 `CM_NCM_MATCH_SOURCE` 指定上游支持的**单个**音源名；留空由上游自动选择。
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
