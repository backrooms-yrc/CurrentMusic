# 歌曲音质、副歌与其他版本

这三个接口根据 NCM 上游文档中的 `/song/music/detail`、`/song/chorus` 和
`/song/copyright/rcmd` 整理出稳定字段，供 Web 歌曲详情及第三方客户端使用。
Web 播放页的“歌曲详情”中可以查看音质文件资料、选择副歌段落和其他版本。
迷你播放条和全屏播放页会在进度条上标出已识别的高潮（副歌）区间。

## 通用约定

- 站点请求前缀为 `/cm`，下文均列出完整路径。
- 公开 GET，无需 Bearer；`id` 必须为正整数且不超过 `9223372036854775807`。
- 参数错误返回 HTTP 400；上游失败、业务拒绝或响应结构异常返回 HTTP 502 和 `{"error":"…"}`，不会伪装为无资料。
- 成功结果缓存 600 秒，按歌曲、接口和用户真实 IP 隔离；失败不缓存。
- RealIP 由后端通过统一规则读取 NGINX 请求头。查询参数中的 `realIP`、`cookie` 不转发；不会使用服务器 IP 代替用户 IP。代理配置见 [RealIP 规则](realip.md)。
- 空数组表示上游成功响应且没有相应资料。

## 音质文件资料

`GET /cm/song/qualities?id=33894312`

```json
{
  "id": 33894312,
  "qualities": [
    {"level":"exhigh","label":"极高","br":320000,"size":10691439,"sr":44100},
    {"level":"sky","label":"沉浸环绕声","br":811759,"size":27120991,"sr":44100,
     "variants":[{"immerseType":"ste","br":811759,"size":27120991,"sr":44100}]}
  ],
  "playability": "unknown"
}
```

以上为结构示例；实际档位、参数和变体随歌曲变化。`br` 为 bit/s，`size` 为字节，
`sr` 为 Hz；缺失的数值为 0。`variants` 仅在沉浸环绕声档位出现。

| 上游字段 | 播放参数 level | 名称 |
| --- | --- | --- |
| l / m / h | standard / higher / exhigh | 标准 / 较高 / 极高 |
| sq / hr | lossless / hires | 无损 / Hi-Res |
| je / db / vi | jyeffect / dolby / vivid | 高清臻音 / 杜比全景声 / 臻音全景声 |
| jm / sk | jymaster / sky | 超清母带 / 沉浸环绕声 |

`sk` 的 `sks` 变体列表映射为 `variants`，`immerseType` 包括 `c512`、`ste2`、
`aac2`、`c51`、`ste`、`aac`。文件资料存在不代表当前用户有权播放。
`playability` 固定为 `unknown`；实际取址继续使用需要登录的 `/cm/ncm/song/url`，
并以其返回的实际档位为准。参见 [播放音源与灰色曲目匹配](playback-sources.md)。

## 副歌段落

`GET /cm/song/chorus?id=2058263032`

```json
{"id":2058263032,"segments":[{"startMs":152916,"endMs":178690}]}
```

接口按网易云歌曲 ID 查询，返回 `id` 和 `segments`。`startMs` 和 `endMs` 是从曲首算起的非负整数毫秒，且 `endMs > startMs`。列表按开始时间排序并去重，过滤其他曲目的区间以及无效或超出 JavaScript 安全整数范围的时间。无副歌资料时 `segments` 为空数组。

Web 将所有有效区间以金色绘制在进度条上，按播放器总时长换算位置。起点在曲长之外的区间省略，终点超出曲长时截到曲尾。切歌时会清除旧标记。资料为空或请求失败时仍可正常拖动进度条。

歌曲详情中的“播放副歌”会定位到区间起点。客户端调用秒制播放器时使用 `startMs / 1000`。选择其他歌曲的副歌时，Web 会先加载目标音频再定位。音源解析失败或等待期间切歌时会取消定位。

## 其他版本推荐

`GET /cm/song/versions?id=27946878`

```json
{
  "id":27946878,
  "songs":[{
    "ncm_id":4888613,"name":"パラジクロロベンゼン","artists":"鏡音レン / オワタP",
    "artist_ids":[190527,159039],"album":"EXIT TUNES PRESENTS Vocalogenesis",
    "pic":"https://example.test/cover.jpg","duration":234894,"fee":0,"pop":75,"mv":34797193
  }],
  "playability":"unknown"
}
```

仅提取上游 `data.rcmd`（单个对象或列表），按 ID 去重并排除请求的原曲。
`data.originSong` 是原曲信息，不作为其他版本展示。`songs` 使用 CurrentMusic
统一歌曲字段，`duration` 为毫秒。推荐版本必须由用户主动选择，不能自动冒充
原版；仍需实际解析确认可播放。上游没有推荐时返回 `songs: []`。

原始上游接口仍保留在 `/cm/ncm/song/music/detail`、`/cm/ncm/song/chorus` 和
`/cm/ncm/song/copyright/rcmd`，沿用原有网关权限与响应格式。
