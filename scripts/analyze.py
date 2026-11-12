"""Offline perceptual and CLIP image indexing; newline JSON protocol."""
import json
import os
import sys

class ModelError(Exception):
    pass

os.environ.setdefault('OMP_NUM_THREADS', '2')
os.environ.setdefault('HF_HUB_OFFLINE', '1')


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def load_image(filename):
    from PIL import Image, ImageOps
    with Image.open(filename) as original:
        image = ImageOps.exif_transpose(original).convert('RGBA')
        return Image.alpha_composite(Image.new('RGBA', image.size, 'white'), image).convert('RGB')


def fingerprint(image):
    import numpy as np
    from PIL import Image
    gray = np.asarray(image.convert('L').resize((32, 32), Image.Resampling.LANCZOS), dtype=np.float64)
    transform = np.cos(np.pi / 32 * (np.arange(32) + .5)[None, :] * np.arange(8)[:, None])
    dct = transform @ gray @ transform.T
    values = dct.reshape(-1)
    threshold = np.median(values[1:])
    bits = values > threshold
    bits[0] = False
    number = 0
    for bit in bits:
        number = (number << 1) | int(bit)
    return f'{number:016x}'


def clip_runtime(payload):
    import torch
    from safetensors import safe_open
    from transformers import CLIPVisionConfig, CLIPVisionModelWithProjection, CLIPImageProcessor
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    with open(payload['clipConfig'], encoding='utf-8') as file:
        config = CLIPVisionConfig(**json.load(file))
    # Convert one mapped tensor at a time; avoid keeping a full fp32 copy in RAM.
    with safe_open(payload['clipModel'], framework='pt', device='cpu') as file:
        weights = {}
        for key in file.keys():
            tensor = file.get_tensor(key)
            weights[key] = tensor.to(torch.bfloat16) if tensor.is_floating_point() else tensor
    with torch.device('meta'):
        model = CLIPVisionModelWithProjection(config)
    missing, unexpected = model.load_state_dict(weights, strict=False, assign=True)
    if missing or any(key != 'vision_model.embeddings.position_ids' for key in unexpected):
        raise ValueError('CLIP 视觉模型与本地配置不匹配')
    # Non-persistent buffers are omitted from state_dict; meta construction leaves
    # position indices unmaterialized even though every learned weight is loaded.
    embeddings = model.vision_model.embeddings
    embeddings.position_ids = torch.arange(embeddings.num_positions, device='cpu').expand((1, -1))
    if any(value.is_meta for value in list(model.parameters()) + list(model.buffers())):
        raise ValueError('视觉模型仍有未加载的参数或位置索引')
    model.eval()
    processor = CLIPImageProcessor(size={'shortest_edge': config.image_size}, crop_size={'height': config.image_size, 'width': config.image_size})
    return torch, model, processor


def group(records, mode, level):
    import numpy as np
    remaining = list(range(len(records)))
    groups = []
    if mode == 'semantic':
        import base64
        matrix = np.stack([np.frombuffer(base64.b64decode(row['vector']), dtype=np.int8).astype(np.float32) for row in records]) if records else np.empty((0, 1024))
        lengths = np.linalg.norm(matrix, axis=1, keepdims=True)
        matrix = matrix / np.maximum(lengths, 1e-12)
        threshold = {'strict': .94, 'normal': .88, 'loose': .80}[level]
    else:
        threshold = {'strict': 3, 'normal': 6, 'loose': 10}[level]
        hashes = [int(row['hash'], 16) for row in records]
    count = 0
    while remaining:
        anchor = remaining[0]
        if mode == 'semantic':
            scores = matrix[remaining] @ matrix[anchor]
            selected = [(idx, round(float(score), 4)) for idx, score in zip(remaining, scores) if score >= threshold or idx == anchor]
        else:
            selected = [(idx, (hashes[idx] ^ hashes[anchor]).bit_count()) for idx in remaining if (hashes[idx] ^ hashes[anchor]).bit_count() <= threshold and abs(records[idx]['ratio'] - records[anchor]['ratio']) <= .2]
        chosen = {idx for idx, _ in selected}
        chosen.add(anchor)
        if len(selected) > 1:
            groups.append({'representative': records[anchor]['id'], 'members': [{'id': records[idx]['id'], 'score': score} for idx, score in selected]})
        remaining = [idx for idx in remaining if idx not in chosen]
        count += 1
        if count % 100 == 0:
            emit({'event': 'grouping', 'remaining': len(remaining)})
    return groups


def main():
    import base64
    import numpy as np
    payload = json.load(sys.stdin)
    records, runtime = [], None
    for row in payload['images']:
        try:
            cached = row.get('cached')
            if cached and (payload['mode'] != 'semantic' or cached.get('vector')):
                record = cached
            else:
                image = load_image(row['path'])
                record = {'id': row['id'], 'stamp': row['stamp'], 'hash': fingerprint(image), 'ratio': round(image.width / image.height, 4)}
                if payload['mode'] == 'semantic':
                    if runtime is None:
                        emit({'event': 'loading', 'message': '正在 CPU 加载本地 CLIP 视觉模型…'})
                        try:
                            runtime = clip_runtime(payload)
                        except Exception as error:
                            raise ModelError(str(error)) from error
                    torch, model, processor = runtime
                    with torch.inference_mode():
                        inputs = processor(images=image, return_tensors='pt')
                        inputs['pixel_values'] = inputs['pixel_values'].to(next(model.parameters()).dtype)
                        vector = model(**inputs).image_embeds[0].float()
                        if not torch.isfinite(vector).all() or vector.norm() < 1e-12:
                            raise ValueError('视觉模型返回无效特征；该图片未加入分组')
                        vector = vector / vector.norm().clamp(min=1e-12)
                    quantized = np.rint(vector.numpy() * 127).clip(-127, 127).astype(np.int8)
                    record.update(vector=base64.b64encode(quantized.tobytes()).decode('ascii'), modelKey=payload['modelKey'])
                emit({'event': 'item', 'record': record})
            records.append(record)
            emit({'event': 'progress'})
        except ModelError:
            raise
        except Exception as error:
            emit({'event': 'itemError', 'id': row['id'], 'error': str(error)})
    del runtime
    emit({'event': 'grouping', 'remaining': len(records)})
    groups = group(records, payload['mode'], payload['level'])
    emit({'event': 'done', 'groups': groups, 'indexed': len(records)})


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        emit({'event': 'fatal', 'error': str(error)})
        sys.exit(1)
