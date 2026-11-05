# 用户等级、试炼与发现排序

## 活跃积分

使用有效的 CurrentMusic 登录会话访问需要识别账号的 API 时，按北京时间（`Asia/Shanghai`）每天首次访问加 10 分。同一账号在多个设备上访问时共享每日额度。既有账号从 Lv.1 和 0 分开始累计，积分体系启用前的活跃记录不补分。

| 等级 | 累计积分门槛 |
| --- | ---: |
| Lv.1 | 0 |
| Lv.2 | 50 |
| Lv.3 | 150 |
| Lv.4 | 300 |
| Lv.5 | 600 |
| Lv.6 | 1,000 |

登录用户通过 `GET /cm/auth/me` 或 `GET /cm/bootstrap` 的 `me` 读取累计积分 `points` 和等级 `level`。公开资料和发现用户列表只提供等级。等级用整数表示，`1` 到 `6` 对应 Lv.1 到 Lv.6，`7` 对应 Lv.6 Plus。积分最高为 2,147,483,647。

## 规则与试炼

| 方法 | 路径 | 权限 | 请求与响应 |
| --- | --- | --- | --- |
| GET | `/cm/levels/rules` | 公开 | 返回 `dailyPoints`、`maxPoints`、`timeZone`、`levels: [{level, points}]` 和 `trial: {level, plusLevel, questionCount, passScore, maxScore}` |
| GET | `/cm/levels/trial` | Bearer | 返回 `questions: [{prompt, options}]`，顺序用于提交答案。Lv.1 至 Lv.5 返回 403，Lv.6 Plus 返回 409 |
| POST | `/cm/levels/trial` | Bearer | JSON 提交 `answers`，含 10 个从 0 开始的选项下标，按题目顺序排列。返回 `{score, passed, level}` |
| POST | `/cm/admin/users/{id}/progression` | 管理员 Bearer | JSON 提交整数 `points` 和 `level`，返回 `{ok, points, level}` |

试炼共 10 道单选题，每题 10 分。服务器判分，60 分及格。Lv.6 及格后升至 Lv.6 Plus，未及格可再次提交。重复提交已通过的答案仍返回 Lv.6 Plus。试炼答错不扣积分，也不降低等级。答案缺失、数量错误、下标越界或类型错误返回 400，Lv.1 至 Lv.5 提交返回 403。

管理台的 `GET /cm/admin/users` 返回每个用户的 `points` 和 `level`。管理员可独立设置任一账号的积分和等级，包括 Lv.6 Plus。后续活跃积分照常累计，跨过新的积分门槛时可继续升至更高的常规等级。更新不存在的用户返回 404，字段类型或范围错误返回 400。

## 发现用户排序

`GET /cm/users/square` 继续支持 `query`、`listening`、`limit` 与 `offset`。新增的 `sort` 值如下。

| 值 | 排序方式 |
| --- | --- |
| `composite` | 默认。依次按等级、累计积分、最近活跃降序 |
| `active` | 按最近登录会话活跃时间降序。会话活跃时间约每分钟更新一次 |
| `level` | 按等级降序，Lv.6 Plus 排在 Lv.6 前面 |

筛选条件先于排序。符合条件的置顶用户仍排在首位，其余按站长、超管、管理员、普通用户分组，每组再应用所选排序。新排序并列时按用户 ID 降序。原有的 `reg`、`reg_asc`、`name`、`days`、`listen`、`likes` 仍可使用。缺省或未知的排序值使用 `composite`。
