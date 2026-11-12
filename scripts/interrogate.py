"""Local WD14 inference bridge. No downloads or ComfyUI server required."""
import argparse
import csv
import json
import math
import sys
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--probe', action='store_true')
    parser.add_argument('--validate-image', action='store_true')
    parser.add_argument('--export-first-frame', action='store_true')
    args = parser.parse_args()
    if args.probe:
        import importlib.util
        missing = [name for name in ('PIL', 'numpy', 'onnxruntime') if importlib.util.find_spec(name) is None]
        print(json.dumps({'ok': not missing, 'missing': missing}))
        return

    payload = json.load(sys.stdin)
    if args.validate_image or args.export_first_frame:
        import warnings
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = 40000000
        warnings.simplefilter('error', Image.DecompressionBombWarning)
        with Image.open(payload['image']) as image:
            if image.format not in ('PNG', 'JPEG', 'WEBP', 'GIF') or image.width * image.height > 40000000:
                raise ValueError('请选择 4000 万像素以内的 PNG、JPEG、WebP 或 GIF 图片')
            image.load()
            if args.export_first_frame:
                from PIL import ImageOps
                with open(payload['output'], 'xb') as target:
                    ImageOps.exif_transpose(image).convert('RGBA').save(target, format='PNG')
            print(json.dumps({'width': image.width, 'height': image.height}))
        return
    import numpy as np
    import onnxruntime as ort
    from PIL import Image, ImageOps

    started = time.perf_counter()
    settings = ort.SessionOptions()
    settings.log_severity_level = 3
    settings.intra_op_num_threads = 2
    settings.inter_op_num_threads = 1
    # Keep background generation's GPU available. Never silently download weights.
    session = ort.InferenceSession(payload['model'], sess_options=settings, providers=['CPUExecutionProvider'])
    info = session.get_inputs()[0]
    shape = info.shape
    if len(shape) != 4:
        raise ValueError('WD14 模型输入维度应为 4')
    nchw = shape[1] == 3
    height, width = (shape[2], shape[3]) if nchw else (shape[1], shape[2])
    height = height if isinstance(height, int) and height > 0 else 448
    width = width if isinstance(width, int) and width > 0 else 448
    if max(height, width) > 4096:
        raise ValueError('模型输入尺寸超出范围')
    with Image.open(payload['image']) as original:
        image = ImageOps.exif_transpose(original).convert('RGBA')
        background = Image.new('RGBA', image.size, 'white')
        image = Image.alpha_composite(background, image).convert('RGB')
    # Resize even small images to the model's expected scale, then pad in white.
    ratio = min(width / image.width, height / image.height)
    size = (max(1, round(image.width * ratio)), max(1, round(image.height * ratio)))
    image = image.resize(size, Image.Resampling.LANCZOS)
    canvas = Image.new('RGB', (width, height), 'white')
    canvas.paste(image, ((width - image.width) // 2, (height - image.height) // 2))
    array = np.asarray(canvas, dtype=np.float32)[:, :, ::-1]
    if nchw:
        array = array.transpose(2, 0, 1)
    scores = session.run(None, {info.name: np.ascontiguousarray(array[None, ...])})[0].reshape(-1)
    with open(payload['labels'], encoding='utf-8-sig', newline='') as source:
        reader = csv.DictReader(source)
        if not {'name', 'category'}.issubset(reader.fieldnames or []):
            raise ValueError('标签 CSV 缺少 name / category')
        labels = list(reader)
    if len(labels) != len(scores):
        raise ValueError('模型和标签 CSV 数量不匹配，请选择配套文件')
    options = payload['options']
    excluded = {tag.strip().lower().replace(' ', '_') for tag in options['excludeTags'].split(',') if tag.strip()}
    tags, ratings = [], []
    for row, score in zip(labels, scores):
        score = float(score)
        if not math.isfinite(score):
            continue
        category = int(row['category'])
        name = row['name']
        item = {'tag': name, 'confidence': round(score, 6), 'category': category}
        if category == 9:
            ratings.append(item)
        elif category in (0, 4) and score >= options['characterThreshold' if category == 4 else 'threshold'] and name.lower().replace(' ', '_') not in excluded:
            tags.append(item)
    tags.sort(key=(lambda item: item['tag'].casefold()) if options['sortAlpha'] else (lambda item: -item['confidence']))
    ratings.sort(key=lambda item: -item['confidence'])
    prompt = []
    for item in tags:
        value = item['tag']
        if options['replaceUnderscore']:
            value = value.replace('_', ' ')
        if options['escapeBrackets']:
            value = value.replace('(', r'\(').replace(')', r'\)')
        if options['includeConfidence']:
            value = f"({value}:{item['confidence']:.3f})"
        prompt.append(value)
    print(json.dumps({'text': ', '.join(prompt), 'tags': tags, 'ratings': ratings,
                      'elapsedSec': round(time.perf_counter() - started, 3), 'provider': 'CPU'}, ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False))
        sys.exit(1)
