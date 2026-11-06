# 按歌词搜索与命中前后文

`GET /cm/ncm/search?keywords=测试&type=lyric&limit=10&offset=0` 为公开接口。
`type=lyric` 明确使用上游歌词搜索类型 1006，不再退回普通歌曲/全类型搜索。
歌词搜索必须单独指定，不能与其他 type 混用；不传 type 的历史四类型行为保持不变。

## 响应

```json
{
  "songs": [{
    "ncm_id": 1,
    "name": "示例歌曲",
    "lyric": "前一句 · 测试命中行 · 后一句",
    "lyricMatch": "测试命中行",
    "lyricContextComplete": true,
    "lyricContextStatus": "complete",
    "lyricContextRetryable": false,
    "lyricContext": [
      {"t": 1000, "txt": "前一句", "matched": false},
      {"t": 2000, "txt": "测试命中行", "matched": true},
      {"t": 3000, "txt": "后一句", "matched": false}
    ]
  }],
  "totals": {"song": 31},
  "hasMore": {"song": true}
}
```

- `songs` 保留现有歌曲字段、上游顺序和分页；`totals.song`、`hasMore.song` 兼容 X 侧现有协议。
- **`lyric` 不再用原始单句充当前后文。** 成功时它是由真实歌词相邻行组成的预览；
  失败时它是明确的不可用/重试提示，因此只读取此字符串的已有客户端也不会误以为拿到了完整前后文。
  `lyricMatch` 保留命中片段，定位成功后为实际命中行（跨行命中时包含这些行）。
- `lyricContext` 为有序上下文；`t` 是毫秒，未带时间轴的完整歌词为 null；`matched` 标识实际命中范围。
  命中片段跨两行或更多行时返回整个连续命中范围及其前后各一句，不能假定数组总是三项。
- 匹配会处理 HTML 高亮/实体、空白、标点、大小写和简繁差异（只转换匹配键，保留歌词原文），先定位原始命中片段，再使用关键词。
  同一句重复出现时取首个实际匹配位置；不会把不相邻的搜索命中拼成上下文。
- 歌词首尾只返回实际存在的一侧。仅有一句完整歌词时不伪造邻行，状态为 single_line。

## 补全状态

| lyricContextStatus | 含义 | lyricContextRetryable |
| --- | --- | --- |
| complete | 已取得命中范围及实际存在的前后文 | false |
| pending | 整页等待上限内仍未完成；任务可继续预热，重试可直接读取结果 | true |
| error | 尝试新版、旧版接口及网络重试后仍失败 | true |
| missing | 接口明确标记纯音乐或未收录，且没有其他可用歌词 | false |
| unmatched | 取得全文，但无法定位这个搜索命中范围 | false |
| single_line | 全文只有一句，没有邻行 | false |

`lyricContextComplete` 仅在 complete 时为 true。状态文案在 `lyric` 中直接显示；
临时失败与确实未提供歌词严格区分，不能把 error/pending 当作“没有歌词”。

## 服务端自动补全与时延

一次搜索请求内执行以下步骤，客户端无需发第二次请求才能取得通常可用的前后文：

1. 优先匹配本站当前版本缓存的完整归一化歌词。缓存中的 LDDC 歌词在有官方 LRC 正文时已做版本复核。
2. 请求 `/lyric/new`，临时失败自动重试；分别检查 LRC、YRC、翻译和罗马音轨，
   不让残缺 LRC 遮住完整 YRC。
3. 新版接口失败、全文为空或命中范围无法定位时，自动尝试 `/lyric`，同样支持网络重试。
   某首歌进入旧版接口补全时，不必等待其他慢歌曲先完成。
4. 按搜索结果顺序滚动分配任务。最多 36 个在途/排队任务，6 个工作线程，按歌曲和来源合并请求。
   一页超过队列容量时继续调度后续项，不能把后面的歌曲直接丢成单句。

取消旧实现的 2.5 秒提前截断；整页补全上限为 15 秒。仍保留有限等待，避免上游持续断网时卡住服务。
超出上限明确返回 pending；这不是完整上下文成功响应。查询不批量触发 LDDC，仅复用本站已有缓存
并获取官方歌词；真正未提供歌词时无法生成不存在的前后句。

## 缓存

取得的全文按歌曲及接口缓存 1 小时；接口通过 nolyric/uncollected 明确标记没有歌词时缓存 60 秒。
只有 code=200 却没有歌词内容的响应按临时失败处理，不作为确实缺词的证据。
**超时/网络失败不做负缓存；包含任何未完成上下文的搜索响应不缓存。**
完整上下文搜索响应缓存 600 秒，键包含 keyword、type、offset、limit；缓存版本 v3 与旧版歌词预览隔离。
后台任务在请求结束后取得全文时，后续重试立即可见，不需要再等 10 秒响应缓存或 30 秒失败缓存过期。

验证：`tools/run-tests.sh -p test_search_lyrics.py`，使用临时数据库；包括超过旧 2.5 秒阈值的
第一次响应、同请求重试与旧版接口补全、跨行命中、残缺 LRC/完整 YRC、复用归一化歌词、
滚动队列、慢歌隔离、失败状态区分、立即恢复、分页和响应缓存规则。

部署前安装 `python3 -m pip install -r deploy/requirements-auth.txt -r deploy/requirements-search.txt`。
OpenCC 依赖及字典遵循 Apache-2.0，许可见 THIRD_PARTY_NOTICES.md。
