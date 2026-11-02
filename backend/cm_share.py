"""服务端分享图渲染（v1.28.50 修订）。

客户端（网页/App）仍会本地 canvas 生成分享图，离线也能出图；本模块为**后端 API**
补上同一张图的渲染能力，供第三方客户端直接取图，避免各自实现一套版式。

依赖（均为可选，缺失时接口返回 503，不影响其他功能）：
  · Pillow（python3-pil，系统已有）
  · segno（python3-segno，Debian 包）
  · Noto Sans CJK 字体（/usr/share/fonts/opentype/noto/*.ttc，SC 面 index=2）

版式与客户端保持一致：1080×1440、封面取色背景、封面/歌名/歌手/专辑、链接文案、
二维码（4 模块静区）。图片按「分享链接 + 版式版本」缓存 7 天，Host 变化不会串图。
"""
from __future__ import annotations

import colorsys
import hashlib
import os
import threading
import time

import cm_db
import cm_image
import cm_net

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps
    import segno
    _DEPS = True
except Exception:  # noqa: BLE001 依赖缺失时接口降级为 503
    _DEPS = False

W, H = 1080, 1440
STYLE = "v1.28.68"
CACHE_TTL = 7 * 86400
CACHE_MAX = 240
SHARE_LABELS = {
    "song": "MUSIC SHARE",
    "playlist": "PLAYLIST SHARE",
    "local-playlist": "PLAYLIST SHARE",
    "artist": "ARTIST SHARE",
    "album": "ALBUM SHARE",
}
FONT_REG = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
FONT_BOLD = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
FONT_MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
SC_INDEX = 2
SHARE_DIR = os.environ.get("CM_SHARE_DIR",
                           os.path.join(os.path.dirname(cm_db.DB_PATH), "share"))


class ShareUnavailable(Exception):
    """依赖/字体缺失或渲染失败。"""


def ready() -> bool:
    return bool(_DEPS and os.path.isfile(FONT_REG) and os.path.isfile(FONT_BOLD))


def _font(path, size):
    if path.endswith(".ttc"):
        return ImageFont.truetype(path, size, index=SC_INDEX)
    return ImageFont.truetype(path, size)


def _hsl(h, s, l):
    r, g, b = colorsys.hls_to_rgb((h % 360) / 360.0, l, s)
    return int(r * 255), int(g * 255), int(b * 255)


def _lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def palette_hue(img):
    """从封面提取主色相（与客户端同口径：饱和度/中间亮度加权）。"""
    small = img.resize((40, 40))
    bins = {}
    for r, g, b in small.getdata():
        h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
        if l < 0.12 or l > 0.9 or s < 0.12:
            continue
        hd = h * 360
        k = int(hd // 15) % 24
        w = s * (0.35 + min(1, l * 1.6)) * (1 - abs(l - 0.52))
        acc = bins.setdefault(k, [0.0, 0.0])
        acc[0] += w
        acc[1] += hd * w
    if not bins:
        return 268.0
    best = max(bins.values(), key=lambda v: v[0])
    return best[1] / best[0]


def _background(hue):
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    c1, c2, c3 = _hsl(hue, 0.52, 0.08), _hsl(hue + 18, 0.46, 0.13), _hsl(hue + 42, 0.42, 0.17)
    for y in range(H):
        t = y / (H - 1)
        col = _lerp(c1, c2, t / 0.55) if t < 0.55 else _lerp(c2, c3, (t - 0.55) / 0.45)
        d.line([(0, y), (W, y)], fill=col)
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([340, -380, 1420, 700], fill=(*_hsl(hue, 0.9, 0.62), 70))
    gd.ellipse([-420, 760, 700, 1880], fill=(*_hsl(hue + 50, 0.8, 0.58), 52))
    glow = glow.filter(ImageFilter.GaussianBlur(110))
    return Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")


def _fetch_cover(url):
    """只抓网易云封面 CDN；不跟随重定向，格式/像素受限（防 SSRF 与解压炸弹）。"""
    if not url:
        return None
    try:
        sep = "&" if "?" in url else "?"
        data, ctype = cm_net.fetch(url + sep + "param=800y800",
                                   allowed_suffixes=("music.126.net",),
                                   timeout=6.0, max_bytes=8 * 1024 * 1024)
        if not ctype.startswith("image/"):
            return None
        return cm_image.open_image(data, formats=("JPEG", "PNG", "WEBP")).convert("RGB")
    except Exception:  # noqa: BLE001 封面失败 → 渐变占位
        return None


def _fit(draw, text, font, max_w):
    s = str(text or "")
    if draw.textlength(s, font=font) <= max_w:
        return s
    while s and draw.textlength(s + "…", font=font) > max_w:
        s = s[:-1]
    return s + "…"


def _wrap(draw, text, font, max_w, max_lines=2):
    out, line = [], ""
    for ch in str(text or ""):
        if draw.textlength(line + ch, font=font) > max_w and line:
            out.append(line)
            line = ch
            if len(out) >= max_lines - 1:
                break
        else:
            line += ch
    if line and len(out) < max_lines:
        out.append(line)
    if out and len("".join(out)) < len(str(text or "")):
        out[-1] += "…"
    return out or [""]


def _draw_qr(draw, text, cx, cy, max_side):
    m = segno.make(text, error="m").matrix
    n = len(m)
    cell = max(2, max_side // (n + 8))          # 上下左右各 4 模块静区
    side = cell * (n + 8)
    x, y = cx - side // 2, cy - side // 2
    draw.rounded_rectangle([x, y, x + side, y + side], radius=18, fill=(255, 255, 255))
    ox, oy = x + 4 * cell, y + 4 * cell
    for r in range(n):
        for c in range(n):
            if m[r][c]:
                draw.rectangle([ox + c * cell, oy + r * cell,
                                ox + (c + 1) * cell - 1, oy + (r + 1) * cell - 1], fill=(17, 17, 17))


def render(meta, share_url):
    """渲染分享图，返回 PIL Image（RGB）。"""
    if not ready():
        raise ShareUnavailable("服务端分享图未启用（缺少 Pillow / segno / CJK 字体）")
    cover = _fetch_cover(meta.get("pic") or "")
    hue = palette_hue(cover) if cover else 268.0
    img = _background(hue)

    # 封面阴影 + 圆角封面
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([230, 192, 850, 812], radius=32, fill=(0, 0, 0, 110))
    img = Image.alpha_composite(img.convert("RGBA"),
                                shadow.filter(ImageFilter.GaussianBlur(28))).convert("RGB")
    if cover:
        cimg = ImageOps.fit(cover, (620, 620), method=Image.LANCZOS)
    else:
        cimg = Image.new("RGB", (620, 620), _hsl(hue, 0.5, 0.32))
        cd = ImageDraw.Draw(cimg)
        cd.text((310, 340), "♪", font=ImageFont.truetype(FONT_MONO, 240), fill=(255, 255, 255), anchor="mm")
    mask = Image.new("L", (620, 620), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, 620, 620], radius=32, fill=255)
    img.paste(cimg, (230, 180), mask)
    draw = ImageDraw.Draw(img)

    # 品牌
    kind = str(meta.get("type") or "song")
    draw.text((90, 70), "CurrentMusic", font=_font(FONT_BOLD, 42), fill=(240, 240, 240))
    draw.text((90, 124), SHARE_LABELS.get(kind, "SHARE"),
              font=_font(FONT_BOLD, 22), fill=(170, 170, 170))

    # 主标题 / 副标题 / 补充信息（歌曲复用 artists/album，其他类型用 sub/sub2）
    f_name, f_artist, f_album = _font(FONT_BOLD, 54), _font(FONT_REG, 32), _font(FONT_REG, 26)
    sub = meta.get("sub") or meta.get("artists") or ""
    sub2 = meta.get("sub2") or meta.get("album") or ""
    y = 860
    for line in _wrap(draw, meta.get("name"), f_name, 900, 2):
        draw.text((90, y), line, font=f_name, fill=(255, 255, 255))
        y += 72
    if sub:
        draw.text((90, y + 6), _fit(draw, sub, f_artist, 900),
                  font=f_artist, fill=(200, 200, 200))
    if sub2:
        draw.text((90, y + 52), _fit(draw, sub2, f_album, 900),
                  font=f_album, fill=(150, 150, 150))

    # 分隔线与底部文案
    draw.line([(90, 1090), (W - 90, 1090)], fill=(70, 70, 70), width=2)
    cta = meta.get("cta") or ("在 CurrentMusic 收听" if kind == "song" else "在 CurrentMusic 打开")
    draw.text((90, 1140), cta, font=_font(FONT_REG, 24), fill=(150, 150, 150))
    url_short = share_url.replace("https://", "").replace("http://", "")
    draw.text((90, 1185), _fit(draw, url_short, _font(FONT_MONO, 22), 610),
              font=_font(FONT_MONO, 22), fill=(210, 210, 210))
    draw.text((90, 1228), "扫码或访问链接", font=_font(FONT_REG, 20), fill=(130, 130, 130))
    hint = meta.get("hint") or f'也可打开 CurrentMusicX 搜索「{meta.get("name") or ""}」'
    draw.text((90, 1268), _fit(draw, hint, _font(FONT_REG, 19), 610),
              font=_font(FONT_REG, 19), fill=(150, 150, 150))

    # 二维码
    _draw_qr(draw, share_url, 860, 1250, 258)
    return img


def ensure_image(meta, share_url) -> str:
    """生成/命中缓存，返回 JPEG 绝对路径。"""
    if not ready():
        raise ShareUnavailable("服务端分享图未启用（缺少 Pillow / segno / CJK 字体）")
    os.makedirs(SHARE_DIR, exist_ok=True)
    key = hashlib.sha1(f"{STYLE}|{share_url}".encode()).hexdigest()[:12]
    prefix = str(meta.get("type") or "song")
    fp = os.path.join(SHARE_DIR, f"{prefix}-{int(meta.get('id') or 0)}-{key}.jpg")
    if os.path.isfile(fp) and time.time() - os.path.getmtime(fp) < CACHE_TTL:
        return fp
    try:
        img = render(meta, share_url)
        tmp = f"{fp}.{os.getpid()}.{threading.get_ident()}.tmp"
        img.save(tmp, "JPEG", quality=92, optimize=True)
        os.replace(tmp, fp)
    except ShareUnavailable:
        raise
    except Exception as e:  # noqa: BLE001
        raise ShareUnavailable(f"分享图生成失败：{e}")
    # 环形清理：目录里只留最近 CACHE_MAX 张
    try:
        files = [os.path.join(SHARE_DIR, n) for n in os.listdir(SHARE_DIR) if n.endswith(".jpg")]
        if len(files) > CACHE_MAX:
            for old in sorted(files, key=os.path.getmtime)[: len(files) - CACHE_MAX]:
                os.remove(old)
    except OSError:
        pass
    return fp
