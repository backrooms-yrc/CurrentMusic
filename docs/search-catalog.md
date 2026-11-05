# 搜索地区与公开曲库补充

`GET /cm/ncm/search` 使用 NGINX 覆盖写入的用户真实 IP，取值与音源获取一致。
客户端的 `realIP` 查询参数不会覆盖它；所有上游搜索分支均传入同一个用户 IP，
搜索缓存同时隔离用户 IP、关键词、类型、偏移和条数。详见 [RealIP 规则](realip.md)。

## 公开专辑曲目匹配

上游搜索与公开专辑目录可能返回不同的曲目集合。若常规搜索省略某首原版，
可将网易云公开专辑的曲目元数据加入独立索引，通过完整歌名或“歌手 + 歌名”精确匹配。
此索引不读取本站用户的私人歌单、播放历史或账号内容，也不保存音频。

管理员按公开歌手 ID 更新索引：

```bash
python3 tools/update-search-catalog.py --artist <歌手ID>
```

可重复传入 `--artist`。默认写入被 Git 忽略的 `data/search-catalog.json`，
或通过 `CM_SEARCH_CATALOG` 指定路径。所有上游读取成功后才原子替换索引；
文件更新会自动改变搜索缓存版本。该维护任务取公开元数据，不使用用户 Cookie。

单曲搜索首屏可附带 `catalogSongs`，元素沿用 `songs` 的归一化结构，
另含 `catalogSource: "netease-album"`。`songs`、`totals.song` 和 `hasMore.song`
仍表达上游原分页，`offset` 不计入补充曲目。客户端应按 `ncm_id` 合并去重，
加载下一页时按已取回的**上游条目数**计算偏移。

Web 将精确匹配放在单曲列表前部，并保持普通搜索与“显示更多”分页正确。
元数据可被检索不代表获得播放权限，播放仍使用现有音源获取与权限处理。

## 网易云红心状态

`GET /cm/ncmbind/likelist?refresh=1` 可绕过列表缓存，读取当前绑定账号状态。
红心写操作成功后，服务端会在短期内保留目标状态，避免网易云最终一致性延迟
使刚点亮的红心退回空心；上游确认或 120 秒后清理。

前端合并并发列表读取、统一数字 ID、按会话隔离缓存；返回前台时重新同步。
播放页先更新红心，再异步补统计数量，旧统计响应不能覆盖新红心。

验证使用临时数据库：`tools/run-tests.sh -p test_search_realip.py` 与
`tools/run-tests.sh -p test_ncm_like_state.py`；浏览器回归见
`tools/test-ncm-like-sync.cjs`、`tools/test-search-catalog.cjs`。
