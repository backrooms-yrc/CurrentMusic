# 歌词 API

`GET /cm/ncm/lyric?id=<ncmId>`（公开，无需登录）

返回归一化歌词：主歌词、翻译、罗马音，以及可选的逐字/逐词时间轴。数据来源按
**网易云官方 YRC → LDDC 逐字源 → 自研估算** 的顺序选择；LDDC 未配置或没匹配时
自动退回估算，不增加接口失败率。

## 响应

```json
{
  "isYrc": false,
  "source": "lddc:kg",
  "wordLevel": true,
  "lines": [
    {
      "t": 6973,
      "txt": "埃をかぶったノート",
      "trans": "笔记本上落满了灰尘",
      "roma": "",
      "w": [[6973, "埃"], [7725, "を"], [8254, "か"], [8454, "ぶ"], [8714, "っ"], [8938, "た"], [9179, "ノ"], [9443, "ー"], [9707, "ト"]],
      "words": [
        {"start": 6973, "end": 7725, "text": "埃"},
        {"start": 7725, "end": 8254, "text": "を"},
        {"start": 8254, "end": 8454, "text": "か"},
        {"start": 8454, "end": 8714, "text": "ぶ"},
        {"start": 8714, "end": 8938, "text": "っ"},
        {"start": 8938, "end": 9179, "text": "た"},
        {"start": 9179, "end": 9442, "text": "ノ"},
        {"start": 9443, "end": 9707, "text": "ー"},
        {"start": 9707, "end": 10107, "text": "ト"}
      ]
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `lines[].t` | int | 行开始时间，毫秒 |
| `lines[].txt` | string | 主歌词文本（已去掉时间标签） |
| `lines[].trans` | string | 翻译，可能为空 |
| `lines[].roma` | string | 罗马音，可能为空 |
| `lines[].w` | array? | 逐字/逐词轴：`[起始毫秒, 字/词]`，按时间升序；所有 token 拼接等于 `txt` |
| `lines[].words` | array? | 供 CurrentMusicX 下一版接入的逐词对象：`{text,start,end}`；当前最新版暂不支持 LDDC 逐字。LDDC 源带真实结束时间，官方 YRC 的 `end` 按相邻 token 推算 |
| `lines[].wSynth` | bool? | `true` 表示该行 `w` 是服务端按行时长估算的，不是官方/第三方逐字数据 |
| `isYrc` | bool | 网易云上游是否存在官方 YRC；LDDC 结果也为 `false` |
| `source` | string | `ncm:yrc` / `ncm:lrc` / `ncm:inst` / `lddc:kg` / `lddc:ne` / `lddc:qm` / `none` |
| `wordLevel` | bool | 主轨是否主要来自真正的逐字数据（官方 YRC 或 LDDC VERBATIM） |
| `instrumental` | bool? | 纯音乐（`source=ncm:inst`），不会请求 LDDC |

客户端渲染逐字动画时：

1. 有 `w` 就按 token 的 `[t, text]` 点亮，`txt` 仍可作为无障碍/复制文本；
2. 没有 `w` 时按整行显示；
3. 需要区分“真实逐字”与“估算”时，检查该行的 `wSynth`；
4. 需要逐词结束时间（例如原生客户端的词级动画）时优先用 `words`。

## 数据来源

### 1. 网易云官方 YRC（最高优先级）

- 请求上游 `/lyric/new`，同时解析 YRC、LRC、翻译 `tlyric`、罗马音 `romalrc`。
- 官方 YRC 存在时直接使用，不再请求 LDDC。
- 翻译/罗马音按文本与时间对齐，兼容两轨时间戳不完全一致。

### 2. LDDC（没有官方 YRC 时）

[LDDC](https://github.com/chenmozhijin/LDDC) 是 GPL-3.0-only 的独立歌词工具。
CurrentMusic 通过本机 `127.0.0.1:3015` 桥接服务调用它，源码不进入后端仓库：

- 用歌名/歌手/专辑/时长在酷狗、网易云、QQ 音乐等源检索并按 LDDC 同口径打分；
- 只接受真正的逐字结果（VERBATIM）覆盖自研轴；如果网易云完全没有歌词，
  也接受 LDDC 的逐行同步歌词；
- 自动去掉酷狗 KRC 开头的「歌名 - 歌手/群星」元数据行；
- 保留 LDDC 的翻译/罗马音；缺失时用网易云的对应行补齐，但**永不覆盖
  LDDC 的真实逐字时间**；
- 桥接检索总 deadline 为 **5 秒**，后端等待上限 **7 秒**；超时/失败即回退网易云
  行级歌词，避免单首歌把首屏拖到 10 秒；
- “版权/地区不可播”的播放地址会做 **60 秒负缓存**，客户端重试不会反复打上游；
- QQ 源偶发上游错误时自动跳过，不影响酷狗/网易云源。

安装/停用见 `deploy/install-lddc.sh` 与 `deploy/README.md`。

### 3. 自研估算（最终兜底）

- 上游只有 LRC 时，用相邻行时间差为每行生成 `w`；
- 日语/中文按单字切分，英文按单词切分；
- 行内按可见字符长度分配时间；
- 超长空档最多铺 8 秒，避免一句歌词缓慢点亮十几秒；
- 这些行带 `wSynth: true`，**不等于官方卡拉 OK 时间轴**。

## 出口清洗与匹配复核（v1.28.75 起，缓存键 `lyric:v16`）

所有来源（官方 YRC / LDDC / 估算）在返回前统一处理，保证消费端逐字渲染稳定：

- **制作名单保留**：作词/作曲/制作人/混音等行与网易云 App 一致，照常返回；
  只修时间轴，不改歌词内容；
- 相邻行 `t` 相同（KRC 常把片头行全排 `t=0`）顺次 +1ms，保证严格递增；
- 逐字 `w`/`words` 满足：token 拼接与 `txt` 逐字符一致、起始时间严格递增、
  `end > start`、首 token ≥ 行起始。同起始 token 会合并进前一个
  （拼接结果不变）；对不上的行宁可整行去掉逐字，也不下发错位时间轴；
- **双语 LRC 合并**：不少外语歌没有 tlyric，上传者把“原文/中文译文”写成两条不同时间轴的行。
  仅在相邻、脚本相反、时间差 1~15 秒，且**至少 4 组、占全篇 1/3 以上**时，才合并为
  `txt=原文, trans=译文` 并移除译文行；阈值用于避免把正常的中英文交替歌词误判成译文
  （实测《Dauntless》7/12 组合并，《Cause you know》2/87 组保持原样）；
- **LDDC 匹配复核**：候选歌曲的歌手/时长必须与网易云元数据一致，否则拒绝该结果
  并回退到网易云歌词。“同名异曲”（翻唱/DJ/同名不同歌手）是整轨歌词错乱的
  常见来源，宁可没有逐字，也不能给错歌的歌词。

## 缓存

- 官方 YRC / LDDC 命中：缓存 7 天。
- 只有网易云 LRC + 自研估算：缓存 2 小时（`CM_LDDC_RETRY_TTL` 可调），
  给 LDDC 后续补词留出重试窗口。
- 纯音乐（`ncm:inst`）不请求 LDDC，缓存 7 天。
- LDDC 未配置时仍按 7 天缓存，不影响旧部署行为。
- 缓存键带归一化版本（当前 `lyric:v16:<id>`），格式升级后旧值自动失效。

## 示例

```bash
curl -s 'https://music.example.com/cm/ncm/lyric?id=3340112781'
```

```bash
curl -s 'https://music.example.com/cm/ncm/lyric?id=3340112781' \
  | jq '{source, wordLevel, lines: (.lines|length), first: .lines[0]}'
```
