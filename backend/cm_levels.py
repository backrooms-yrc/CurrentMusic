"""CurrentMusic 活跃积分规则和试炼题库。"""

DAILY_POINTS = 10
LISTEN_SECONDS = 60
# 每次积分与每日次数上限。按账号去重，由写入对应事件的事务发放。
POINT_SOURCES = {
    "visit": (DAILY_POINTS, 1),
    "listen": (2, 5),
    "post": (5, 1),
    "comment": (2, 2),
}
MAX_POINTS = 2_147_483_647
THRESHOLDS = (0, 50, 150, 300, 600, 1000)
TRIAL_LEVEL = len(THRESHOLDS)
PLUS_LEVEL = TRIAL_LEVEL + 1
PASS_SCORE = 60
POINTS_PER_QUESTION = 10

# 每题为题干、选项、正确选项下标。接口只返回题干与选项。
QUESTIONS = (
    ("在 CurrentMusic 中，想把歌曲收进「我喜欢的音乐」，应该怎么做？",
     ("点亮歌曲的红心", "退出账号", "切换播放线路"), 0),
    ("希望自己的账号从「发现 → 用户」列表中隐藏，可以怎么做？",
     ("清空播放队列", "关闭「公开到发现页」", "切换深色模式"), 1),
    ("想继续播放刚才听过的歌曲，可以到哪里找？",
     ("线路测速", "登录设备", "最近播放"), 2),
    ("哪种做法有助于保护账号？",
     ("把验证码发给陌生人", "在公用设备上用完后退出登录", "公开自己的会话令牌"), 1),
    ("单曲循环开启后，一首歌播放结束时通常会怎样？",
     ("再次播放同一首歌", "随机切换一首歌", "自动删除这首歌"), 0),
    ("歌曲的逐字歌词主要用来做什么？",
     ("更改歌曲音量", "显示歌曲的文件大小", "随播放进度标记正在唱的字词"), 2),
    ("听音乐时，哪种习惯有助于保护听力？",
     ("把音量一直开到最大", "使用适中音量并适时休息", "在嘈杂环境下持续调高音量"), 1),
    ("想和朋友在 CurrentMusic 一起同步听歌，可以使用哪个功能？",
     ("一起听房间", "账号安全设置", "歌曲音质详情"), 0),
    ("发现不认识的设备正在登录自己的账号，应该怎么做？",
     ("把密码发到聊天室", "继续共享这个会话", "撤销该设备的会话并检查账号安全"), 2),
    ("调整均衡器中的低频增益，会主要改变什么？",
     ("歌单的播放顺序", "低频声音的相对强弱", "歌曲的播放速度"), 1),
)


def rules():
    return {
        "dailyPoints": DAILY_POINTS,
        "maxPoints": MAX_POINTS,
        "timeZone": "Asia/Shanghai",
        "pointSources": [
            {"id": source, "points": points, "dailyLimit": limit}
            for source, (points, limit) in POINT_SOURCES.items()
        ],
        "listenSeconds": LISTEN_SECONDS,
        "levels": [{"level": i, "points": points} for i, points in enumerate(THRESHOLDS, 1)],
        "trial": {"level": TRIAL_LEVEL, "plusLevel": PLUS_LEVEL, "questionCount": len(QUESTIONS),
                  "passScore": PASS_SCORE, "maxScore": len(QUESTIONS) * POINTS_PER_QUESTION},
    }


def day_start(now):
    return now - (now + 8 * 3600) % 86400  # Asia/Shanghai


def trial_questions():
    return [{"prompt": prompt, "options": options} for prompt, options, _ in QUESTIONS]


def trial_score(answers):
    if not isinstance(answers, list) or len(answers) != len(QUESTIONS):
        raise ValueError(f"请回答全部 {len(QUESTIONS)} 道题")
    score = 0
    for answer, (_, options, correct) in zip(answers, QUESTIONS):
        if type(answer) is not int or not 0 <= answer < len(options):
            raise ValueError("试炼答案格式错误")
        if answer == correct:
            score += POINTS_PER_QUESTION
    return score
