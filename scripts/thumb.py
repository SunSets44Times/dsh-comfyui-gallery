"""One bounded Pillow thumbnail job. The Node owner supplies a unique temp file."""
import sys
from PIL import Image, ImageOps

def main():
    source, target, maximum = sys.argv[1:]
    with Image.open(source) as original:
        original.seek(0)
        original.thumbnail((int(maximum), int(maximum)), Image.Resampling.LANCZOS)
        image = ImageOps.exif_transpose(original)
        if image.mode not in ("RGB", "RGBA"):
            image = image.convert("RGBA" if "transparency" in image.info else "RGB")
        image.save(target, format="WEBP", quality=82, method=4)

if __name__ == "__main__":
    main()
