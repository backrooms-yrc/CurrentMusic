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

匹配调用也带同一 `realIP` 参数，但当前 api-enhanced 的匹配模块仅调用
`matchID(id, source)`，没有把用户 IP 传给第三方匹配库。

## 匹配结果与失败

匹配响应必须含 HTTP(S) 地址，且服务端实际读取到音频文件头。
HTML 错误页、HTTP 拒绝、连接失败或探测超时均不视为可播放；这条路径的校验
比官方音源严格，避免第三方返回网页链接后被误报为可用。

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

`type`、`size`、`sr`、`bits`、`ch` 仅填写实际可验证的文件信息；未知值为空或 0。
匹配接口不保证请求的音质或 `maxBr` 上限，不能把它标成无损、母带或沉浸声。
Web 显示“匹配音源”。第三方地址不参与网易云 CDN 边缘替换。
成功结果按用户 IP 缓存 120 秒，`refresh=1` 会重新解析；失败不缓存。
原有官方音源失败缓存不会阻止匹配接口重试。

可选环境变量 `CM_NCM_MATCH_SOURCE` 指定上游支持的**单个**音源名；留空由上游自动选择。
不支持的音源、上游网络或服务故障仍会失败，此时返回可重试错误，不把未知原因直接判作版权限制。

验证：`tools/run-tests.sh -p test_playback_sources.py`；全部测试使用临时数据库。
