#!/usr/bin/env python3
"""首屏聚合端点（/bootstrap）的离线回归测试（纯标准库，不联网、不碰数据库）。

两道关键约束：
1. 单项失败只置空——首页不能因为"猜你喜欢"上游超时就整页空白；
2. 并行执行，不是串行（否则聚合反而比逐个请求更慢）。
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))
import cm_server  # noqa: E402

FAIL = []


def ok(label, cond):
    print(("  ✅ " if cond else "  ❌ ") + label)
    if not cond:
        FAIL.append(label)


print("① 单项失败不影响其它项")
out = cm_server._run_isolated({
    "good": lambda: {"v": 1},
    "bad": lambda: (_ for _ in ()).throw(RuntimeError("上游超时")),
    "also_good": lambda: [1, 2, 3],
})
ok("成功项保留（%s）" % sorted(k for k, v in out.items() if v is not None), out.get("good") == {"v": 1})
ok("失败项置 None 且不抛异常", out.get("bad") is None)
ok("失败项之后的项照常执行", out.get("also_good") == [1, 2, 3])

print("② 并行执行（总耗时应接近最慢的一项，而不是各项之和）")
def slow(ms):
    def fn():
        time.sleep(ms / 1000)
        return ms
    return fn
t0 = time.time()
res = cm_server._run_isolated({"a": slow(300), "b": slow(300), "c": slow(300)})
dt = time.time() - t0
ok("三项各 300ms，总耗时 %.2fs < 0.6s（并行）" % dt, dt < 0.6)
ok("结果齐全（%s）" % sorted(res.values()), sorted(res.values()) == [300, 300, 300])

print("③ 空任务不报错")
ok("空字典返回空", cm_server._run_isolated({}) == {})

print("④ 路由存在且是 GET")
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend", "cm_server.py"), encoding="utf-8").read()
ok("注册了 /bootstrap GET", 'path == "/bootstrap" and method == "GET"' in src)
ok("聚合复用 _payload_daily（不重复实现）", "_payload_daily(u)" in src)

print("⑤ 四个 payload 函数已抽出且被原路由复用（重构无分叉）")
for fn in ("_payload_daily", "_payload_me", "_payload_bind", "_payload_recent"):
    ok("定义了 %s" % fn, ("def %s(" % fn) in src)
ok("/auth/me 复用 _payload_me", "_payload_me(require_user(handler))" in src)
ok("/ncmbind 复用 _payload_bind", "_payload_bind(require_user(handler))" in src)
ok("/plays/recent 复用 _payload_recent", "_payload_recent(u, int(q.get" in src)

print()
if FAIL:
    print("  失败 %d 项：" % len(FAIL))
    for f in FAIL:
        print("    - " + f)
    sys.exit(1)
print("  全部通过 ✅")
