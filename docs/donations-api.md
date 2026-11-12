# 官方捐赠与第三方接入

官方捐赠渠道允许已登录用户扫码捐赠后自助提交交易单号，记录进入站长管理台。CurrentMusicX 等第三方客户端可以直接复用这套 API，把捐赠入口嵌进自己的「关于 / 设置」页面，不需要自行收款或保存任何支付信息。

## 接入流程（三步）

推荐与官方 Web 端一致的三步交互；其中第 1、3 步各一次请求，二维码图片可直接展示。

```text
① GET /cm/donation/info      确认账号基本信息（服务端快照，客户端不要自建表单收集）
② GET /cm/donation/qr        展示捐赠码，用户自行扫码支付（金额由用户在支付应用内决定）
③ POST /cm/donation          用户回到应用，填写金额与交易单号提交
```

### 第 1 步：读取引导信息

`GET /cm/donation/info`，需要 `Authorization: Bearer <token>`。

```json
{
  "qrPath": "/donation/qr",
  "profile": {
    "username": "demo",
    "nickname": "示例用户",
    "email": "demo@example.com",
    "phone": "",
    "created_at": 1763000000
  },
  "noteMax": 120,
  "txnMax": 64,
  "mine": { "items": [ { "id": 1, "amount_cents": 660, "note": "加油", "txn_id": "TX20261113001", "created_at": 1763000123 } ],
            "count": 1, "totalCents": 660 }
}
```

- `profile` 是服务端从账号记录生成的快照，**客户端只需原样展示确认，不要再向用户索要用户名 / 邮箱 / 手机号**；提交时后端同样以服务端记录为准。
- `noteMax` / `txnMax` 是备注与交易单号长度上限，可据此设置输入框 `maxlength`。
- `mine` 是本人捐赠历史与累计（`amount_cents` 单位为分），可在入口处展示「已捐赠 N 次 · 累计 ¥X」。

### 第 2 步：展示捐赠码

`GET /cm/donation/qr`，**公开接口**，无需登录，返回 `image/jpeg`。直接用图片组件加载 `<api-base>/cm/donation/qr` 即可（图片组件无法带 Authorization 头，这正是它设计为公开的原因）。响应声明 24 小时公共缓存，可在客户端做同样时长的缓存；换码后旧缓存自然过期。

### 第 3 步：提交交易单号

`POST /cm/donation`，需要 Bearer token。

```json
{ "amount": 6.6, "txnId": "TX20261113001", "note": "加油" }
```

| 字段 | 要求 |
| --- | --- |
| `amount` | 数字，0.01 ~ 100000（元）。这是**用户自报金额**，仅用于展示与核对 |
| `txnId` | 6~64 位数字/字母/`._-`，支付应用账单详情中可查；全站唯一 |
| `note` | 可选，最长 120 字，超长部分服务端截断 |

成功返回 `200 {"ok": true, "mine": {...}}`，`mine` 为提交后的最新历史，可直接刷新界面。

### 错误语义

| 状态码 | 含义 | 建议提示 |
| --- | --- | --- |
| 401 | 未登录 / token 失效 | 引导重新登录 |
| 400 | 金额越界或单号格式不符 | 按上文规则做前端预检后再提交 |
| 409 | 交易单号已提交过 | 提醒用户核对单号，不要重复提交 |

## 管理端（仅站长侧）

`GET /cm/admin/donations` 提供搜索、分页与按用户聚合的次数 / 累计金额（`sort=recent/amount/user_total/user_count/...`），`DELETE /cm/admin/donations/{id}` 用于清理误报。这两个接口需要管理员权限，第三方客户端无需接入。

## 隐私与边界

- 交易单号、自报金额与账号快照仅存于 CurrentMusic 服务端，供站长核对捐赠记录，不会下发给其他用户。
- 捐赠完全自愿，不得与任何功能解锁、等级或权益挂钩；客户端不应把捐赠金额展示给捐赠者以外的用户。
- 官方 Web 端实现见 `web/src/pages/donate.js`，可作为交互与文案参考。
