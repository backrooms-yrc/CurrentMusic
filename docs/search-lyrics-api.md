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
- `lyric` 仍是字符串，供已有客户端展示；取得可靠前后文时以 ` · ` 连接前一句、命中句、后一句。
  `lyricMatch` 为单独的命中句。`lyricContext` 为按时间顺序的结构化上下文，`t` 单位毫秒。
- 搜索片段中的高亮 HTML 会去除，实体解码为普通文字。原始命中片段精确匹配优先；
  忽略大小写、空白和标点后仍无法定位时，可使用搜索关键词定位。重复行取首个匹配位置。
- 前后文来自同一首歌完整官方 LRC/YRC 的相邻非空行，不把上游多个不相邻的搜索命中拼成上下文。
  歌词首尾自然只返回实际存在的一侧。`lyricContextComplete=true` 表示已可靠定位并取得实际存在的邻行，
  不要求首尾也强行凑满三句。
- 全文不可用、超时或无法可靠定位时，`lyric`/`lyricMatch` 保留上游原始命中片段（没有片段时为空），
  `lyricContext=[]`、`lyricContextComplete=false`。客户端可显示单句，或按歌曲 ID 请求 `/cm/ncm/lyric`
  在用户展开时重试；不能把降级结果当作已取得前后文。

## 时延与缓存

全文补全只读取 `/lyric/new` 的官方 LRC/YRC，不为搜索结果批量触发 LDDC。
全局 6 个工作线程、最多 36 个在途/排队查词任务，按歌曲 ID 合并重复查词；每页最多额外等待 2.5 秒。
未完成任务可继续预热缓存，不阻塞搜索响应；预算用尽的结果明确降级。

完整歌词在有界内存缓存中保存 1 小时，空/失败结果保存 30 秒。搜索响应含 keyword、type、offset、limit
的独立缓存键；完整上下文响应缓存 600 秒，部分降级响应仅缓存 10 秒，后续请求可取得预热结果。
用户界面能展示多少行仍由各客户端布局决定，服务端同时提供完整结构化字段。

验证：`tools/run-tests.sh -p test_search_lyrics.py`，使用临时数据库，覆盖真实路由、1006 参数、
前后行/首尾/重复行、HTML 清理、分页兼容、超时降级、缓存预热和查词去重。
