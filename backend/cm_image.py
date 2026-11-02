"""受限图片解码（防解压炸弹 / 非预期格式）。

Pillow 9.4 仍在 Debian 安全补丁维护，但 2026 年仍有 PSD/PDF/ImageCms 等
解析器 CVE；本站只处理头像、分享封面与聊天图片，因此这里只放行
JPEG/PNG/WebP（必要时 GIF），并限制总像素数、强制完整解码一次。
"""
from __future__ import annotations

import io

MAX_PIXELS = 25_000_000
SAFE_FORMATS = ("JPEG", "PNG", "WEBP")


def open_image(data: bytes, formats=SAFE_FORMATS, max_pixels: int = MAX_PIXELS):
    """返回已 load 的 PIL.Image；超过像素上限/格式不符抛 ValueError。"""
    try:
        from PIL import Image
    except Exception as e:  # noqa: BLE001
        raise ValueError("图片处理组件不可用") from e
    if not data or len(data) > 16 * 1024 * 1024:
        raise ValueError("图片过大")
    Image.MAX_IMAGE_PIXELS = max_pixels
    try:
        im = Image.open(io.BytesIO(data), formats=list(formats))
        w, h = im.size
        if w <= 0 or h <= 0 or w * h > max_pixels:
            raise ValueError("图片尺寸过大")
        im.load()
        return im
    except ValueError:
        raise
    except Exception as e:  # noqa: BLE001
        raise ValueError("图片格式不受支持或已损坏") from e
