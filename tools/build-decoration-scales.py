#!/usr/bin/env python3
"""为每款挂件定 CSS 放大比例：把素材的「设计尺寸」放大到等于头像直径。

素材自带透明留白且留白程度差异极大（可见内容只占画布宽 0.09~1.0），逐款取值：

1) 圆环测量可靠（径向剖面法测得环外径 r，0.42 ≤ r ≤ 1）→ scale = 1/r。
   「看得见的圆环」是最强的设计基准：放大后环外沿正好与头像边缘重合。
   实测 296 款落在此区间，scale 与 r 互为倒数（环外径 × scale ≡ 1.000）。

2) 其余（虚线环 / 碎片环 / 只有小配件的稀疏素材）→ 这类素材的可见外接框
   本身贴在画面边缘（vw≈0.3~1.0），且环测量不可信；用外接框宽度换算半径再比头像半径，
   即 scale ≈ 0.5 / (vw/2) × 0.55 = 0.55/vw，并夹到 [1.0, 2.0]。
   系数 0.55 的来历：环类素材的可见范围中位 0.64、环外径中位 0.578，
   两者之比 ≈ 0.90，代入即得该式；实测该口径下这类素材的偏差在 ±15% 内。

3) 统一下限 1.0（绝不缩小素材）。

输出写回 decorations/manifest.json 的 scale 字段。
"""
import json, os, statistics, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, "decorations", "manifest.json")
GEOM = "/tmp/decor-geom.json"        # 可见外接框（measure_decor.py）
RING = "/tmp/decor-ring.json"        # 径向剖面环外径（measure_ring2.py）

FLOOR = 1.0
UPPER_RING = 2.6          # 有环：环测得准，允许较大放大
UPPER_PROP = 2.0          # 无环：按可见范围估，收紧上限
RING_MIN, RING_MAX = 0.42, 1.0
PROP_K = 0.55             # 无环兜底系数（见文件头推导）
DEFAULT_VW = 0.64


def main():
    geom = {x["file"]: x for x in json.load(open(GEOM))}
    ring = {x["file"]: x for x in json.load(open(RING))}
    man = json.load(open(MANIFEST, encoding="utf-8"))

    n_ring = n_prop = 0
    for m in man:
        f = m["file"]
        r = ring.get(f, {})
        g = geom.get(f, {})
        rv = r.get("ring") if r.get("has_ring") else 0
        vw = g.get("vw") if isinstance(g.get("vw"), float) else 0
        if rv and RING_MIN <= rv <= RING_MAX:
            s, cap = 1.0 / rv, UPPER_RING
            n_ring += 1
        else:
            s, cap = PROP_K / (vw if vw and vw > 0.08 else DEFAULT_VW), UPPER_PROP
            n_prop += 1
        m["scale"] = round(max(FLOOR, min(cap, s)), 2)

    json.dump(man, open(MANIFEST, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    sc = [m["scale"] for m in man]
    print(f"已写入 {MANIFEST}")
    print(f"  按圆环测量 {n_ring} 款 · 按可见范围兜底 {n_prop} 款")
    print(f"  scale 中位 {statistics.median(sc):.2f}  min {min(sc):.2f}  max {max(sc):.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
