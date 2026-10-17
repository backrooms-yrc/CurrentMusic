# CurrentMusicAI（聊天室联网问答助手）

`CurrentMusicAI` 是站内 AI 账号，不是真人。它有一个机器人头像和 **AI** 徽章，
不出现在「发现 → 用户」广场，但可以在 @ 提及选择器里搜到。

## 怎么用

1. 在「发现 → Chat」引用一张卡片（单曲 / 专辑 / 歌手 / 歌单）；
2. 输入 `@` 选择 **CurrentMusicAI**；
3. 输入框上方会自动出现「猜你想问」：
   - 单曲：创作背景 / 出自哪部影视作品 / 歌手生平；
   - 专辑：专辑创作背景 / 代表作 / 歌手生平；
   - 歌手：生平 / 代表作 / 音乐风格；
   - 歌单：主题 / 值得一听的歌 / 适合的场景。
   点一条即可填入问题，也可以自己写；
4. 发送后，AI 会以机器人账号在聊天室里回复（SSE 实时下发）。

没有引用卡片时，AI 会提示先引用一张卡片再提问。

## 模型与联网

- 模型提供商：**深度求索（DeepSeek）**
- 模型：`deepseek-flash`
- 工具：`POST https://api.deepseek.com/v1/tools/search`（联网搜索）与
  `POST https://api.deepseek.com/v1/tools/fetch`（抓取网页正文）
- 服务端按「模型 → 工具调用 → 工具结果 → 模型」循环，最多 4 轮；
  单次请求最多搜索 3 次、抓取 1 个网页；回答控制在 500 字左右（按句子边界截断）。

## 配置

密钥只从环境变量读取，**不写入仓库**：

```ini
# /etc/systemd/system/currentmusic.service.d/ai.conf  (0600)
[Service]
Environment=CM_AI_KEY=sk-...
Environment=CM_AI_MODEL=deepseek-flash
```

修改后 `systemctl daemon-reload && systemctl restart currentmusic`。
未配置密钥时，AI 账号会回复「AI 助手还没接入模型，请联系管理员配置 DeepSeek。」

## 频率与并发

- 同一用户两次提问最小间隔 10 秒；
- 同时最多 2 个 AI 请求；
- 回答失败会回复「联网查询失败了，稍后再问我一次吧。」，不会静默。

## 隐私说明

用户引用的卡片信息（类型、名称、歌手/作者、ID）与问题文本会发送给 DeepSeek
及其联网检索工具；AI 的回答作为一条普通聊天消息保存在聊天室。请勿在提问中
包含敏感个人信息。
