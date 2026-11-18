"""Resource-limited subprocess for feedback media validation and processing."""
import os
import resource
import sys


def screenshot(source, target, content_type, edge, pixels):
    from PIL import Image, ImageOps, UnidentifiedImageError

    expected = {"image/jpeg": "JPEG", "image/png": "PNG"}[content_type]
    with open(source, "rb") as handle:
        prefix = handle.read(8)
    if not prefix.startswith(b"\xff\xd8\xff" if expected == "JPEG" else b"\x89PNG\r\n\x1a\n"):
        return 15
    try:
        if expected == "PNG":
            with Image.open(source, formats=[expected]) as image:
                image.verify()
        with Image.open(source, formats=[expected]) as image:
            width, height = image.size
            if max(width, height) > edge or width * height > pixels or getattr(image, "n_frames", 1) != 1:
                return 22
            oriented = ImageOps.exif_transpose(image)
            mode = "RGBA" if expected == "PNG" and ("A" in oriented.getbands() or "transparency" in oriented.info) else "RGB"
            # Copy pixels into a fresh image so no source metadata reaches the encoder.
            clean = Image.new(mode, oriented.size)
            clean.paste(oriented.convert(mode))
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError, UnidentifiedImageError):
        return 22
    try:
        clean.save(target, format=expected, **({"quality": 90} if expected == "JPEG" else {}))
    except OSError as exc:
        return 13 if exc.errno == 27 else 3
    return 0


def main():
    limit, operation, *args = sys.argv[1:]
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 ** 2, 768 * 1024 ** 2))
    resource.setrlimit(resource.RLIMIT_CPU, (25, 26))
    resource.setrlimit(resource.RLIMIT_FSIZE, (int(limit), int(limit)))
    if operation == "screenshot":
        source, target, kind, edge, pixels = args
        return screenshot(source, target, kind, int(edge), int(pixels))
    os.execv(args[0], args)


if __name__ == "__main__":
    sys.exit(main())
