import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import vm from 'node:vm'
import { deflateSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { GalleryStore, encodeId } from '../lib/store.js'
import { ThumbnailCache } from '../lib/thumb.js'
import { createHandler, apply } from '../lib/index.js'
import { readPngInfo, safeJson } from '../lib/png.js'
import { describeMetadata } from '../lib/extract.js'

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-gallery-test-'))
const root = path.join(fixture, 'images'), cacheDir = path.join(fixture, 'cache')
await fs.mkdir(root)
const graph = {
  1: { class_type: 'DualCLIPLoader', inputs: { clip_name1: 'first.safetensors', clip_name2: 'second.safetensors' } },
  2: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
  3: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['2', 0], lora_name: 'detail.safetensors', strength_model: 0.8 } },
  4: { class_type: 'CLIPTextEncode', inputs: { text: '测试图片，山与海', clip: ['1', 0] } },
  5: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 0] } },
  6: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 768, batch_size: 1 } },
  7: { class_type: 'KSampler', inputs: { model: ['3', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0], seed: 0, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
  8: { class_type: 'CLIPTextEncode', inputs: { text: 'unused branch' } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'sample', images: ['7', 0] } }
}
const workflow = { nodes: [{ id: 7, title: '采样测试' }], groups: [{ title: '测试分组' }] }
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const content = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length); content.copy(out, 4); out.writeUInt32BE(crc32(content), out.length - 4)
  return out
}
function png() {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(32); ihdr.writeUInt32BE(16, 4); ihdr[8] = 8; ihdr[9] = 2
  const pixels = Buffer.alloc(16 * (32 * 3 + 1), 130)
  for (let row = 0; row < 16; row++) pixels[row * 97] = 0
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('iTXt', Buffer.concat([Buffer.from('prompt\0\x01\0\0\0'), deflateSync(Buffer.from(JSON.stringify(graph)))])),
    chunk('tEXt', Buffer.from('workflow\0' + JSON.stringify(workflow))),
    chunk('zTXt', Buffer.concat([Buffer.from('extra\0\0'), deflateSync(Buffer.from('压缩文本'))])),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
const image = path.join(root, 'sample_00001_.png')
await fs.writeFile(image, png())
let store, thumbs, server
let checks = 0
const check = (condition, message) => { assert.ok(condition, message); checks++ }
try {
  const info = readPngInfo(image)
  check(info.width === 32 && info.height === 16, 'PNG IHDR dimensions')
  check(safeJson('{"seed":18446744073709551615,"text":"seed 18446744073709551615","cfg":1.5}').seed === '18446744073709551615', '64-bit seed precision survives JSON parsing')
  check(safeJson('{"seed":0,"text":"quote \\" 12345678901234567890"}').text === 'quote " 12345678901234567890', 'JSON strings are preserved by precise integer parsing')
  check(info.text.extra === '压缩文本', 'compressed text chunk')
  check(JSON.parse(info.text.prompt)['4'].inputs.text === graph['4'].inputs.text, 'compressed Unicode iTXt')
  const metadata = describeMetadata(graph, workflow, info, path.basename(image))
  check(metadata.positive === graph['4'].inputs.text && metadata.negative === '', 'empty negative never mixes other branches')
  check(metadata.models.clip.length === 2, 'both CLIP loaders')
  check(metadata.loras.length === 1 && metadata.loras[0].strength === 0.8, 'LoRA is not duplicated')
  check(metadata.sampling.seed === 0 && metadata.sizeNote.width === 512, 'zero seed and latent dimensions')
  check(metadata.sampling.title === '采样测试', 'workflow titles supplement API graph')
  const multi = structuredClone(graph)
  multi['10'] = { class_type: 'CLIPTextEncode', inputs: { text: 'final branch' } }
  multi['11'] = { class_type: 'KSampler', inputs: { ...graph['7'].inputs, seed: 22, positive: ['10', 0], latent_image: ['7', 0] } }
  multi['12'] = { class_type: 'SaveImage', inputs: { filename_prefix: 'final', images: ['11', 0] } }
  check(describeMetadata(multi, {}, {}, 'final_00001_.png').positive === 'final branch', 'select sampler for the saved output')
  check(describeMetadata(multi, {}, {}, 'sample_00001_.png').sampling.seed === 0, 'original output selects original sampler')
  const qwen = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'qwen.safetensors' } },
    2: { class_type: 'TextEncodeQwenImage21', inputs: { prompt: 'positive words', negative_prompt: 'negative words' } },
    3: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['2', 1] } },
    4: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_vae.safetensors' } },
    5: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 0] } },
    6: { class_type: 'SaveImage', inputs: { images: ['5', 0] } }
  }
  const qwenDescription = describeMetadata(qwen)
  check(qwenDescription.positive === 'positive words' && qwenDescription.negative === 'negative words', 'Qwen multi-output text encoder separates positive/negative')
  check(qwenDescription.models.vae[0] === 'qwen_vae.safetensors', 'VAE on output branch is retained')
  const advanced = {
    1: graph['1'], 4: graph['4'], 5: graph['5'], 6: graph['6'],
    10: { class_type: 'RandomNoise', inputs: { noise_seed: 123 } },
    11: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'heun' } },
    12: { class_type: 'BasicScheduler', inputs: { steps: 20, scheduler: 'normal', denoise: 0.7 } },
    13: { class_type: 'CFGGuider', inputs: { positive: ['4', 0], negative: ['5', 0], cfg: 4 } },
    14: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['10', 0], sampler: ['11', 0], sigmas: ['12', 0], guider: ['13', 0], latent_image: ['6', 0] } }
  }
  const custom = describeMetadata(advanced)
  check(custom.positive === graph['4'].inputs.text && custom.sampling.seed === 123 && custom.sampling.steps === 20 && custom.sampling.samplerName === 'heun' && custom.sampling.cfg === 4, 'advanced sampler resolves noise/schedule/guider')
  const cyclic = { 1: { class_type: 'KSampler', inputs: { positive: ['2', 0] } }, 2: { class_type: 'Reroute', inputs: { value: ['2', 0] } } }
  check(describeMetadata(cyclic).positive === '', 'graph cycles terminate')
  await fs.writeFile(path.join(root, 'not-image.txt'), 'fixture')
  const python = process.env.GALLERY_PYTHON || 'D:\\Program Files\\Comfy UI\\python\\python.exe'
  const py = spawnSync(python, ['-c', 'from PIL import Image; import sys; Image.new("RGB",(40,20)).save(sys.argv[1]); Image.new("RGBA",(25,35)).save(sys.argv[2])', path.join(root, 'plain.jpg'), path.join(root, 'plain.webp')], { windowsHide: true, encoding: 'utf8' })
  assert.equal(py.status, 0, py.stderr)
  await fs.writeFile(path.join(root, 'plain.json'), JSON.stringify({ prompt: graph, workflow }))
  store = new GalleryStore({ roots: [root], cacheDir, warmCount: 0, python })
  await store.ready; await store.refresh()
  let list = await store.list({ limit: 1 })
  check(list.total === 3 && list.items.length === 1, 'list pagination and extension whitelist')
  check(!JSON.stringify(list).includes('rawPrompt') && !JSON.stringify(list).includes('rawWorkflow'), 'list excludes large raw data')
  const id = encodeId(image), detail = await store.detail(id)
  check(detail.width === 32 && detail.height === 16 && detail.sizeNote.width === 512 && typeof detail.size === 'number', 'actual/latent dimensions and file size are distinct')
  check(!Object.hasOwn(detail, 'rawWorkflow'), 'detail excludes raw workflow')
  check((await store.raw(id, 'workflow')) === JSON.stringify(workflow), 'raw JSON is available on demand')
  const jpeg = await store.detail(encodeId(path.join(root, 'plain.jpg')))
  check(jpeg.width === 40 && jpeg.height === 20 && jpeg.hasMetadata, 'JPEG dimensions and sidecar')
  const webp = await store.detail(encodeId(path.join(root, 'plain.webp')))
  check(webp.width === 25 && webp.height === 35, 'lossless WebP dimensions')
  check((await store.list({ q: '山与海' })).total >= 1, 'search cached prompts')
  await fs.writeFile(path.join(root, 'plain.json'), JSON.stringify({ positive: 'sidecar changed', negative: 'flat negative' }))
  check((await store.detail(encodeId(path.join(root, 'plain.jpg')))).positive === 'sidecar changed', 'sidecar updates invalidate metadata cache')
  await store.flush()
  const persisted = JSON.parse(await fs.readFile(path.join(cacheDir, 'index.json'), 'utf8'))
  check(persisted.items.length === 3, 'atomic index is valid JSON')
  const outside = path.join(fixture, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret.png'), png())
  assert.throws(() => store.resolve(encodeId(path.join(outside, 'secret.png'))), { status: 403 }); checks++
  assert.throws(() => store.resolve(encodeId(path.join(root, 'not-image.txt'))), { status: 403 }); checks++
  assert.throws(() => store.resolve('%%%'), { status: 400 }); checks++
  assert.throws(() => store.resolve(encodeId(path.join(root, 'gone.png'))), { status: 404 }); checks++
  await fs.symlink(outside, path.join(root, 'junction'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => store.resolve(encodeId(path.join(root, 'junction', 'secret.png'))), { status: 403 }); checks++
  await store.refresh()
  check((await store.list()).total === 3, 'directory junctions are not traversed')
  thumbs = new ThumbnailCache(store)
  const same = await Promise.all(Array.from({ length: 6 }, () => thumbs.get(id)))
  check(new Set(same).size === 1 && await thumbs.count() === 1, 'concurrent requests share one thumbnail job')
  const thumb = await fs.readFile(same[0])
  check(thumb.toString('ascii', 8, 12) === 'WEBP', 'Pillow produces actual WebP')
  const queueCache = new ThumbnailCache(store)
  let active = 0, peak = 0
  queueCache.generate = async job => {
    active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 10)); active--
    return job.target
  }
  await Promise.all(Array.from({ length: 12 }, (_, n) => new Promise((resolve, reject) => {
    queueCache.queue.push({ target: String(n), resolve, reject }); queueCache.pump()
  })))
  check(peak === 4, 'thumbnail worker concurrency never exceeds four')
  queueCache.close()
  server = http.createServer(createHandler(store, thumbs)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/comfyui-gallery/api/`
  const get = (route, options) => fetch(base + route, options)
  check((await (await get('health')).json()).ok, 'HTTP health')
  const start = performance.now(); const response = await get('list?limit=3'); await response.json()
  const latency = performance.now() - start
  check(latency < 500, 'cached list responds within 500 ms')
  const imageHead = await get('file?id=' + id, { method: 'HEAD' })
  check(imageHead.status === 200 && imageHead.headers.get('content-type') === 'image/png' && (await imageHead.text()) === '', 'HEAD image metadata without body')
  check((await get('file?id=' + id, { headers: { 'if-none-match': imageHead.headers.get('etag') } })).status === 304, 'conditional image requests')
  const thumbResponse = await get('thumb?id=' + id)
  check(thumbResponse.headers.get('content-type') === 'image/webp', 'HTTP thumbnail content type')
  check((await get('raw?id=' + id + '&kind=workflow')).headers.get('content-type').startsWith('text/plain'), 'raw JSON text endpoint')
  check((await get('refresh', { method: 'POST' })).status === 405, 'POST is rejected')
  check((await get('refresh')).status === 200, 'read-only refresh')
  check((await get('item?id=' + encodeId(path.join(outside, 'secret.png')))).status === 403, 'HTTP rejects paths outside roots')
  check((await get('raw?id=' + id + '&kind=other')).status === 400, 'invalid raw kind')
  check((await get('missing')).status === 404, 'unknown route')
  await fs.unlink(image); await store.refresh()
  check((await store.list()).total === 2, 'refresh removes deleted images')
  // Run the browser factory with a small host mock and verify registrations/disposal.
  let browserPlugin
  const styles = new Map()
  const document = { querySelector: () => null, createElement: () => ({ dataset: {}, remove() { styles.delete('style') } }), head: { appendChild(s) { styles.set('style', s) } } }
  const browser = { window: { __ModuleLoader__: { load(definition) { browserPlugin = definition.factory(() => ({ createElement() {} })) } } }, document, Symbol }
  vm.runInNewContext(await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), browser)
  const disposers = [], registrations = []
  browserPlugin.apply({ effect(fn) { disposers.push(fn()) }, slots: { inject(name, fn) { return fn() }, register(def) { registrations.push(def); return () => {} } } })
  check(registrations[0].name === 'main' && registrations[1].name === 'sidebar.panellist' && registrations[1].id === registrations[0].key && registrations[1].label() === 'ComfyUI 图库', 'left sidebar entry selects the gallery main page')
  check(styles.size === 1, 'client installs one stylesheet')
  disposers.reverse().forEach(dispose => dispose())
  check(styles.size === 0, 'client disposes stylesheet')
  const hostDisposers = []
  apply({ effect(fn) { hostDisposers.push(fn()) }, webServer: { register(definition) { check(definition.path === '/comfyui-gallery/api', 'host uses its own prefix'); return () => {} } } }, { roots: [root], cacheDir })
  hostDisposers.forEach(dispose => dispose())
  console.log(JSON.stringify({ ok: true, checks, cachedListMs: Math.round(latency * 10) / 10, thumbnailBytes: thumb.length }))
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  thumbs?.close()
  if (store) await store.close()
  await fs.rm(fixture, { recursive: true, force: true })
}
