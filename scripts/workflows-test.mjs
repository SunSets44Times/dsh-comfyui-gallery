import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import zlib from 'node:zlib'
import { GalleryStore, encodeId } from '../lib/store.js'
import { Workflows, promptSignature, uiSignature, workflowTitle } from '../lib/workflows.js'
import { explainWorkflow } from '../lib/nodes.js'
import { createHandler } from '../lib/index.js'

let checks = 0
const check = (value, label) => { assert.ok(value, label); checks++ }
const equal = (a, b, label) => { assert.equal(a, b, label); checks++ }

// --- PNG writer: only what ComfyUI stamps matters here, so no image library ---
const TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) { let value = i; for (let k = 0; k < 8; k++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; table[i] = value >>> 0 }
  return table
})()
const crc32 = buffer => { let crc = 0xffffffff; for (const byte of buffer) crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0 }
function chunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}
function png(width, height, texts) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) { row[1 + x * 3] = 120; row[2 + x * 3] = 160; row[3 + x * 3] = 200 }
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)]
  for (const [key, value] of Object.entries(texts)) parts.push(chunk('tEXt', Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0]), Buffer.from(value, 'utf8')])))
  parts.push(chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(parts)
}

const apiGraph = ({ seed = 1, text = 'portrait', checkpoint = 'base.safetensors', steps = 20 } = {}) => ({
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text, clip: ['1', 1] } },
  '3': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], seed, steps, cfg: 7, sampler_name: 'euler' } },
  '4': { class_type: 'SaveImage', inputs: { images: ['3', 0], filename_prefix: 'test' } }
})
// `ids` and `pos` exist only to prove they are ignored by the UI signature.
const uiGraph = ({ ids = [1, 2, 3, 4], pos = [0, 0], extra = false, title = '人像工作流' } = {}) => {
  const nodes = [
    { id: ids[0], type: 'CheckpointLoaderSimple', pos },
    { id: ids[1], type: 'CLIPTextEncode', pos: [pos[0] + 10, pos[1] + 20], widgets_values: ['portrait'] },
    { id: ids[2], type: 'KSampler' }, { id: ids[3], type: 'SaveImage' }
  ]
  const links = [
    [1, ids[0], 1, ids[1], 1, 'CLIP'], [2, ids[0], 0, ids[2], 0, 'MODEL'],
    [3, ids[1], 0, ids[2], 1, 'CONDITIONING'], [4, ids[2], 0, ids[3], 0, 'LATENT']
  ]
  if (extra) { nodes.push({ id: 9, type: 'LoraLoader' }); links.push([5, ids[0], 0, 9, 0, 'MODEL']) }
  return JSON.stringify({ nodes, links, groups: [{ title }] })
}

// --- signatures -----------------------------------------------------------------
const baseSig = promptSignature(apiGraph())
equal(promptSignature(apiGraph({ seed: 1, text: 'a', steps: 20 })), promptSignature(apiGraph({ seed: 999999, text: '完全不同的话', steps: 44 })), 'API identity ignores seed, wording and numeric tuning')
check(promptSignature(apiGraph({ checkpoint: 'alt.safetensors' })) !== baseSig, 'API identity changes with the checkpoint')
equal(promptSignature(apiGraph()), baseSig, 'API identity is stable across calls')
equal(promptSignature({}), '', 'API identity is empty without nodes')
equal(promptSignature('nope'), '', 'API identity tolerates a non-object')

equal(uiSignature(JSON.parse(uiGraph({ ids: [4, 5, 6, 7], pos: [900, 40] }))), uiSignature(JSON.parse(uiGraph())), 'UI identity ignores node ids, coordinates and widget values')
check(uiSignature(JSON.parse(uiGraph({ extra: true }))) !== uiSignature(JSON.parse(uiGraph())), 'UI identity changes with the link topology')
equal(workflowTitle(JSON.parse(uiGraph())), '人像工作流', 'group title becomes the display title')
equal(workflowTitle({}), '', 'missing group yields no title')
equal(uiSignature({}), '', 'UI identity is empty without nodes')

// --- node and LoRA explanations --------------------------------------------------
const explained = explainWorkflow({
  nodes: [
    { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['sd15.safetensors'] },
    { id: 2, type: 'LoraLoader', widgets_values: ['detail.safetensors', 0.8, 0.6] },
    { id: 3, type: 'KSampler', widgets_values: [123456, 'randomize', 24, 7.5, 'dpmpp_2m', 'karras', 1] },
    { id: 4, type: 'SaveImage', widgets_values: ['out/test'] },
    { id: 5, type: 'MyCustomNode', widgets_values: ['foo', 42] }
  ], links: []
}, null)
equal(explained.nodes.length, 5, 'every node is explained, including unknown ones')
equal(explained.loras.length, 1, 'one LoRA is detected')
equal(explained.loras[0].name, 'detail.safetensors', 'LoRA file name comes from the first widget')
equal(explained.loras[0].strengthModel, 0.8, 'LoRA model strength is read')
equal(explained.loras[0].strengthClip, 0.6, 'LoRA CLIP strength is read')
equal(explained.models.checkpoint[0], 'sd15.safetensors', 'checkpoint is collected as a model')
equal(explained.nodes[2].label, '采样器', 'KSampler gets a readable label')
check(explained.nodes[2].params.some(pair => pair[0] === 'steps' && pair[1] === '24'), 'sampler params are named and shown')
equal(explained.nodes[4].category, '其它', 'unknown nodes fall into 其它')
equal(explained.nodes[4].label, 'MyCustomNode', 'unknown nodes keep their type as the label')
equal(explained.categories.find(item => item.name === '加载').count, 2, 'categories are counted')
equal(explained.categories[0].name, '加载', 'categories come back in pipeline order')

const fromApi = explainWorkflow(null, {
  '1': { class_type: 'LoraLoader', inputs: { model: ['2', 0], lora_name: 'api.safetensors', strength_model: 0.5, strength_clip: 0.4 } },
  '2': { class_type: 'UNETLoader', inputs: { unet_name: 'flux.safetensors', weight_dtype: 'fp8' } }
})
equal(fromApi.loras[0].name, 'api.safetensors', 'API graph LoRA is detected by input name')
equal(fromApi.loras[0].strengthModel, 0.5, 'API graph LoRA strength is read by input name')
equal(fromApi.models.unet[0], 'flux.safetensors', 'API graph unet is bucketed as unet')
equal(explainWorkflow({}, null).nodes.length, 0, 'an empty workflow explains nothing')

// --- list / item / raw ----------------------------------------------------------
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-workflows-'))
const root = path.join(fixture, 'output'), workflowsDir = path.join(fixture, 'ComfyUI', 'user', 'default', 'workflows')
let store, service, server
try {
  await fs.mkdir(root, { recursive: true }); await fs.mkdir(workflowsDir, { recursive: true })
  const write = async (name, body, seconds) => {
    const filename = path.join(root, name)
    await fs.writeFile(filename, body)
    const stamp = new Date(Date.now() - seconds * 1000)
    await fs.utimes(filename, stamp, stamp)
    return filename
  }
  const older = await write('a.png', png(16, 12, { prompt: JSON.stringify(apiGraph({ seed: 1, text: 'a' })), workflow: uiGraph({ ids: [1, 2, 3, 4] }) }), 300)
  const newer = await write('b.png', png(16, 12, { prompt: JSON.stringify(apiGraph({ seed: 77, text: 'b' })), workflow: uiGraph({ ids: [11, 12, 13, 14], pos: [700, 700] }) }), 60)
  const other = await write('c.png', png(16, 12, { prompt: JSON.stringify(apiGraph({ checkpoint: 'alt.safetensors' })), workflow: uiGraph({ extra: true, title: '另一个工作流' }) }), 120)
  await write('plain.png', png(8, 8, {}), 30)
  const saved = path.join(workflowsDir, '人像.json')
  await fs.writeFile(saved, uiGraph({ ids: [21, 22, 23, 24] }))

  store = new GalleryStore({ roots: [root], cacheDir: path.join(fixture, 'cache'), workflowRoots: [workflowsDir], python: 'node', warmCount: 0 })
  await store.ready
  await store.refresh()
  equal(store.entries.size, 4, 'fixture images are scanned')
  for (const item of store.entries.values()) await store.detail(encodeId(item.path))
  service = new Workflows(store)

  const list = await service.list()
  equal(list.saved, 1, 'only the matching saved file is listed as saved')
  equal(list.total, 2, 'one saved workflow plus one unsaved cluster')
  equal(list.roots.length, 1, 'configured workflow root is reported')
  equal(list.indexed, 3, 'three images carry a workflow signature (the metadata-free PNG does not)')
  const file = list.items.find(item => item.kind === 'file')
  check(file, 'saved workflow appears in the list')
  equal(file.imageCount, 2, 'both runs of the template are attached to the saved file')
  equal(file.name, '人像', 'saved workflow is named after its file')
  equal(file.example, encodeId(newer), 'example image is the most recent run')
  check(file.example !== encodeId(older), 'example image is not the older run')
  const cluster = list.items.find(item => item.kind === 'cluster')
  check(cluster, 'a workflow that was never saved is still listed')
  equal(cluster.imageCount, 1, 'unsaved cluster holds its single run')
  equal(cluster.name, '另一个工作流', 'unsaved cluster borrows the group title')
  equal(cluster.example, encodeId(other), 'unsaved cluster uses its own image as the example')

  equal((await service.list({ q: '另一个' })).total, 1, 'search narrows the list')
  // Han ordering is locale dependent, so assert the order actually applied rather than a pinyin guess.
  const byName = (await service.list({ sort: 'name' })).items.map(item => item.name)
  equal(byName.join('\u0000'), [...byName].sort((a, b) => a.localeCompare(b)).join('\u0000'), 'name sort is applied')
  equal((await service.list({ sort: 'count' })).items[0].name, '人像', 'default sort puts the busiest workflow first')

  const detail = await service.item(file.id)
  equal(detail.images.length, 2, 'detail exposes every run')
  equal(detail.images[0].name, 'b.png', 'detail lists runs newest first')
  equal(detail.nodeCount, 4, 'detail reports the node count')
  check((await service.raw(file.id)).text.includes('CLIPTextEncode'), 'saved file exports its own JSON')
  check((await service.raw(cluster.id)).text.includes('LoraLoader'), 'cluster exports the embedded graph')
  await assert.rejects(service.item('zzz'), { status: 400 }); checks++
  await assert.rejects(service.item('c.0000000000000000'), { status: 404 }); checks++

  // --- HTTP surface -------------------------------------------------------------
  server = http.createServer(createHandler(store, {}, { token: 'fixture-token' }, { workflows: service }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const get = async (url, method = 'GET') => { const response = await fetch(`http://127.0.0.1:${port}${url}`, { method }); return { status: response.status, type: response.headers.get('content-type') || '', body: await response.text() } }
  const listing = await get('/comfyui-gallery/api/workflows')
  equal(listing.status, 200, 'GET /workflows responds')
  equal(JSON.parse(listing.body).total, 2, 'GET /workflows returns the grouped list')
  const one = await get(`/comfyui-gallery/api/workflows/item?id=${encodeURIComponent(file.id)}`)
  equal(JSON.parse(one.body).imageCount, 2, 'GET /workflows/item returns the detail')
  const raw = await get(`/comfyui-gallery/api/workflows/file?id=${encodeURIComponent(file.id)}`)
  equal(raw.status, 200, 'GET /workflows/file responds')
  check(raw.type.includes('application/json'), 'raw workflow is served as JSON')
  equal((await get('/comfyui-gallery/api/workflows/item?id=bad')).status, 400, 'invalid id is rejected')
  equal((await get('/comfyui-gallery/api/workflows/item')).status, 400, 'missing id is rejected')
  const gone = await get(`/comfyui-gallery/api/workflows/item?id=${encodeURIComponent('f.' + Buffer.from(path.join(workflowsDir, 'nope.json')).toString('base64url'))}`)
  equal(gone.status, 404, 'unknown workflow file is a 404')
  equal((await get('/comfyui-gallery/api/workflows', 'POST')).status, 405, 'non-GET is rejected')
  console.log(`workflows test: ${checks} checks passed`)
} finally {
  await new Promise(resolve => server ? server.close(resolve) : resolve())
  await store?.close()
  await fs.rm(fixture, { recursive: true, force: true })
}
