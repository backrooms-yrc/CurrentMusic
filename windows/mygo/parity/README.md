# Windows Web 功能验收

冻结基线为 `c62ad1c01702c32b6224099d8587d12262aa31e9`。功能清单包含 228 个普通用户流程，发布需要通过至少 217 项，其中 72 项为必过项。网易云绑定、房间角色和部署开关相关流程均在清单中。站务管理与公告写入在路由审计中单列，独立开发者控制台和需要 Android 专用桥的入口在范围之外。

- `web-routes.tsv` 逐条核对冻结源码的 52 个路由。路由内操作及播放器、设置、聊天等非路由入口使用 `web-flows.tsv` 计分。
- 每个流程的 `acceptance` 是可核对的用户结果。Windows 特有的个人队列追加、移除和插播继续回归，Web 中的房间队列操作按对应流程计分。
- `verify.py` 核验冻结路由、唯一流程 ID、阶段、证据和发布门槛。测试桩、模拟数据和技术回归单独保留。通过的端到端场景才写入验收回执。

从仓库根目录执行以下命令。网关冒烟测试使用独立临时数据库、随机口令、两个临时账号及回环 HTTP 端口，运行后清理数据库。

~~~powershell
python windows/mygo/parity/verify.py
python windows/mygo/parity/smoke_gateway.py
go -C windows/mygo test -mod=readonly -count=1 ./...
go -C windows/mygo vet -mod=readonly ./...
~~~

验收回执使用以下格式。证据路径相对于回执所在目录。每个证据应记录客户端构建、Windows 版本、后端版本、账号角色、真实依赖和可复现步骤。仅将已通过的实际端到端用例标记为 `passed` 和 `e2e`。

~~~json
{
  "baseline": "c62ad1c01702c32b6224099d8587d12262aa31e9",
  "results": {
    "search-songs": {
      "status": "blocked",
      "environment": "Windows release candidate",
      "reason": "尚无端到端证据"
    }
  }
}
~~~

~~~powershell
python windows/mygo/parity/verify.py --receipt windows/artifacts/mygo-parity/acceptance.json --release
~~~

## 第一阶段回归

- 旧工作区的未提交文件保留在本地 Git 快照 `3d812b4e5f5f0f8c390f8e4cd526c00714f8a48d`。集成分支 `codex/windows-web-parity` 以冻结提交为基线。
- Windows 11 24H2 x64 上重建了 Go 客户端与 C++/WinRT 媒体桥。回环 HTTP 上实测 MP3、两种 FLAC 和 AAC/M4A。三组 20 次 Seek 的最高 P95 为 850 毫秒，最大位置误差为 50 毫秒。换档保持位置和播放状态。原生窗口回归覆盖曲库、歌词、队列及隐藏窗口的系统媒体命令。
- 临时网关经真实 HTTP 路由验证 `/plays/capabilities`、Windows 登录、播放 ID 幂等、账号隔离和尾段提交。54 项听歌时长、歌词和音源后端回归通过。线上主站的兼容能力探测仍返回 404。
- 临时签名 MSI 在隔离产品标识下通过旧版升级、故障回滚、修复、降级阻止和卸载。主机原有安装与进程保留。

命令沿用 [MyGo 构建与验收入口](../README.md)，日志及截图在 `windows/artifacts/mygo-parity/` 下。以上结果记录为基线回归。

## 本轮新增客户端能力

- 账号与曲库接入邮箱及短信注册、找回密码、切换已保存账号、资料和安全设置、设备及授权管理。通行密钥登录与绑定使用同源浏览器页面、短期凭据和 Windows 会话交换。网易云绑定支持二维码、短信、状态检查、续期、解绑、歌单同步及独立红心操作。
- 曲库增加单曲、歌词、专辑、歌手、歌单和多重匹配搜索，接入历史、热搜、建议、最近播放及发现入口。播放详情读取歌曲音源规格、副歌、版本及百科。个人队列按 API 基址和用户保存，支持授权下载与复制歌曲链接。
- 一起听接入建房、密码加入、成员管理、队列审批、播放时间轴、SSE 及长轮询重连。社区接入站内动态、文字回复、点赞、公告和实时文字聊天室。

Windows Go 测试、`go vet`、原生构建及 API 文档生成检查可分别复现。公开搜索用例通过原生 MyGo 测试入口向线上主站发起只读请求，验证分类切换及专辑打开。通行密钥用例验证 PKCE、Origin、绑定会话撤销和单次使用。房间测试覆盖 SSE 不可用后的长轮询、`reset` 快照与断线结束。下载测试覆盖大小校验失败时保留原文件，以及下载请求不携带账号令牌。

临时网关联调使用真实 CurrentMusic HTTP Handler 和两个原生会话，经过本地 HTTPS 测试反代。实测密码登录、歌单双向读取与更新、密码房间加入、跨账号点歌审批、消息送达及动态读回。测试数据均在临时库中。后端房间、聊天室、通行密钥和收听时长共 64 项回归通过。

~~~powershell
$env:CURRENTMUSIC_PARITY_PUBLIC_API = 'https://music.20110208.xyz/cm'
go -C windows/mygo test -mod=readonly -count=1 -v -run '^TestLiveCloudSearchCategories$'
Remove-Item Env:CURRENTMUSIC_PARITY_PUBLIC_API

$env:CURRENTMUSIC_PARITY_PYTHON = (Get-Command python).Source
go -C windows/mygo test -mod=readonly -count=1 -v -run '^TestNativeLibraryAndRoomsAgainstCurrentMusicGateway$'
Remove-Item Env:CURRENTMUSIC_PARITY_PYTHON

$env:PYTHONUTF8 = '1'
python tools/test-api-docs.py
~~~

当前原生 EXE 和媒体桥位于 `windows/artifacts/mygo-parity/current/`。测试签名 MSI 和 SHA-256 位于同级的 `current-msi/`。隔离安装通过全新安装、真实旧包升级、回滚、修复、降级阻止和卸载，安装后独立启动留待干净验收机。

正式回执仍缺少冻结清单要求的端到端证据。已绑定真实账号的同步、Windows Hello、Web 与 Windows 双端音频联调，以及云盘、视频、均衡器、完整分享与社区媒体操作等流程仍需实现或验收。发布还需要干净的 Windows 11 25H2 x64、稳定音频端点下两小时实播和可信时间戳签名。
