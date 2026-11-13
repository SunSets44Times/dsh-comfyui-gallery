import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { Loras, safetensorsMetadata } from '../lib/loras.js'
import { allowedLoraUrl } from '../lib/lora-network.js'
import { GalleryStore, encodeId } from '../lib/store.js'
import { createHandler } from '../lib/index.js'

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-loras-')), root = path.join(fixture, 'models'), cacheDir = path.join(fixture, 'cache')
const python = process.env.GALLERY_PYTHON || 'D:/Program Files/Comfy UI/python/python.exe'
let loras, restored, corrupt, server, store, checks = 0
const check = (value, label) => { assert.ok(value, label); checks++ }
const rejects = async (fn, status) => { await assert.rejects(fn, { status }); checks++ }
const until = async fn => { for (let i = 0; i < 500; i++) { if (await fn()) return; await sleep(10) }; throw new Error('timeout') }
async function model(file, metadata = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const header = Buffer.from(JSON.stringify({ __metadata__: metadata, tensor: { dtype: 'F32', shape: [1], data_offsets: [0, 4] } })), prefix = Buffer.alloc(8)
  prefix.writeBigUInt64LE(BigInt(header.length)); await fs.writeFile(file, Buffer.concat([prefix, header, Buffer.alloc(4)])); return encodeId(file)
}
try {
  const a = path.join(root, 'SDXL', 'style.safetensors'), id = await model(a, { ss_base_model_version: 'sdxl_base_v1-0', ss_network_dim: '16', ss_network_alpha: '8', ss_tag_frequency: JSON.stringify({ setA: { landscape: 4, clouds: 2 }, setB: { landscape: 3 } }), 'modelspec.author': 'fixture-author' })
  await fs.writeFile(a.replace('.safetensors', '.metadata.json'), JSON.stringify({ model_name: '云彩风格', base_model: 'SDXL 1.0', notes: '已有本地备注', civitai: { id: 123, modelId: 456, name: 'v1', trainedWords: ['cloudstyle', 'cloudstyle'], model: { tags: ['style', 'Concept'], description: '<p>Cloud &amp; sky</p>' }, images: [{ type: 'image', url: 'https://image.civitai.com/example/image.png' }] } }))
  const pngPath = a.replace('.safetensors', '.preview.png')
  const drawn = spawnSync(python, ['-c', "from PIL import Image; import sys; Image.new('RGB',(128,96),'skyblue').save(sys.argv[1])", pngPath], { windowsHide: true, encoding: 'utf8' }); assert.equal(drawn.status, 0, drawn.stderr)
  const png = await fs.readFile(pngPath), before = await fs.readFile(a), sidecarBefore = await fs.readFile(a.replace('.safetensors', '.metadata.json'))
  const missing = path.join(root, 'Flux', 'no-preview.safetensors'), missingId = await model(missing)
  const legacy = path.join(root, 'legacy.pt'); await fs.writeFile(legacy, 'not pickle; must never execute')
  const malformed = path.join(root, 'bad.safetensors'); await fs.writeFile(malformed, Buffer.alloc(8, 255))
  const config = { roots: [], loraRoots: [root, path.join(root, 'SDXL')], python, cacheDir, thumbMax: 80, warmCount: 0 }
  store = new GalleryStore(config); await store.ready
  loras = new Loras(store); await loras.ready; await loras.scan
  check(loras.roots.length === 1 && (await loras.list()).indexed === 4, 'recursive roots deduplicated, supported model files found')
  const item = await loras.detail(id)
  check(item.displayName === '云彩风格' && item.base === 'SDXL 1.0' && item.baseSource === '元数据', 'LoRA Manager sidecar preferred over header metadata')
  check(item.triggers.join(',') === 'cloudstyle' && item.tags[0] === 'style' && item.version === 'v1', 'Civitai version triggers and tags recognized')
  check(item.training.dim === '16' && item.training.alpha === '8' && item.creator === 'fixture-author', 'training and author metadata read without loading weights')
  check(item.trainingTags[0].tag === 'landscape' && item.trainingTags[0].count === 7, 'training tag counts aggregated separately from trigger words')
  check(item.description === ' Cloud & sky ' && item.notes === '已有本地备注', 'description rendered as text and local notes retained')
  check(item.preview && item.metadataSources.includes('style.metadata.json'), 'local preview and metadata sources discovered')
  check(item.context.includes('SDXL/style.safetensors') && item.context.includes('cloudstyle') && item.context.includes('权重 1'), 'conversation context carries usable model path and honest weight reference')
  check((await loras.detail(encodeId(legacy))).tensorCount === 0, 'legacy formats never deserialized')
  check((await loras.detail(encodeId(malformed))).metadataError.includes('大小异常'), 'oversized header rejected while model stays browseable')
  check((await loras.detail(missingId)).baseSource === '目录' && (await loras.detail(missingId)).base === 'Flux', 'folder fallback is explicitly identified')
  const [m1, m2] = await Promise.all([loras.annotate(id, { favorite: true, categories: ['风格', '云彩'], note: 'use softly' }), loras.annotate(id, { categories: ['风格', '风格'] })])
  check(m1.favorite && m2.favorite && m2.categories.length === 1 && m2.note === 'use softly', 'concurrent partial updates preserve favorites and notes')
  check((await loras.list({ favorite: '1', category: '风格', base: 'SDXL 1.0' })).total === 1, 'combined favorites category and base filter applied before pagination')
  check((await loras.list({ q: 'cloudstyle', limit: 1 })).total === 1 && (await loras.list({ q: 'use softly' })).total === 1, 'search covers triggers and personal notes')
  check((await loras.list({ folder: 'Flux' })).total === 1 && (await loras.list({ offset: 1, limit: 2 })).items.length === 2, 'directory filter and pagination work')
  check((await loras.list()).categories[0] === '风格', 'category facets include saved labels')
  check((await loras.list({ tags: JSON.stringify(['concept']) })).total === 1 && (await loras.list()).tags.some(tag => tag.name === 'Concept'), 'source tag facets filter case-insensitively')
  await rejects(() => loras.annotate(id, { favorite: 'true' }), 400)
  await rejects(() => loras.annotate(id, { categories: ['x'.repeat(81)] }), 400)
  await rejects(() => loras.annotate(id, { note: 'x'.repeat(4001) }), 400)
  const outside = path.join(fixture, 'outside.safetensors'), outsideId = await model(outside)
  await rejects(() => loras.detail(outsideId), 403)
  await rejects(() => loras.detail('!path'), 400)
  const linkedDir = path.join(root, 'escape'); await fs.symlink(fixture, linkedDir, 'junction')
  await rejects(() => loras.detail(encodeId(path.join(linkedDir, 'outside.safetensors'))), 403)
  await loras.refresh(); await loras.scan
  check(![...loras.entries.values()].some(item => item.relativePath.startsWith('escape/')), 'scan skips linked files and recursive directory escapes')
  check((await fs.readFile(a)).equals(before) && (await fs.readFile(a.replace('.safetensors', '.metadata.json'))).equals(sidecarBefore), 'annotations do not modify weights or manager metadata')
  const thumb = await loras.thumbs.get(id)
  check((await fs.readFile(thumb)).toString('ascii', 0, 4) === 'RIFF', 'real Pillow thumbnail generated from local preview')
  await loras.close()
  restored = new Loras(store); await restored.ready; await restored.scan
  check(restored.mark(id).favorite && restored.mark(id).categories[0] === '风格', 'favorites and categories survive reopening')
  let downloads = [], finish
  restored.download = async (url, kind) => { downloads.push({ url, kind }); if (kind === 'json') return Buffer.from(JSON.stringify({ id: 999, baseModel: 'Flux.1', trainedWords: ['newtrigger'], model: { name: 'Fetched model' }, images: [{ url: 'https://image.civitai.com/test/fixture.png', type: 'image' }] })); return new Promise(resolve => { finish = () => resolve(png) }) }
  check((await restored.fetch(missingId)).state === 'running', 'metadata fetch is a background job')
  await until(() => finish)
  await rejects(() => restored.fetch(id), 429)
  check(downloads[0].url.endsWith(createHash('sha256').update(await fs.readFile(missing)).digest('hex')), 'missing metadata uses SHA256 of local model for lookup')
  finish(); await restored.jobs.get(missingId).task
  const fetched = await restored.detail(missingId)
  check(fetched.preview && fetched.displayName === 'Fetched model' && fetched.triggers[0] === 'newtrigger', 'downloaded metadata and preview become visible')
  check(restored.job(missingId).state === 'done' && (await fs.readFile(restored.preview(missingId).real)).toString('ascii', 0, 4) === 'RIFF', 'background fetch decodes and stores compact WebP preview')
  restored.download = async (url, kind) => { downloads.push({ url, kind }); return png }
  downloads = []; await restored.fetch(id); await restored.jobs.get(id).task
  check(downloads.length >= 1 && downloads.length <= 3 && downloads.every(entry => entry.kind === 'image'), 'existing manager preview URL skips weight hashing and metadata requests, fetching 1-3 preview images')
  for (const url of ['http://image.civitai.com/a', 'https://localhost/a', 'https://image.civitai.com.evil.test/a', 'https://image.civitai.com:123/a', 'https://user:secret@image.civitai.com/a']) {
    assert.throws(() => allowedLoraUrl(url)); checks++
  }
  assert.throws(() => allowedLoraUrl('https://civitai.com/api/download/models/1', 'json')); checks++
  check(allowedLoraUrl('https://civitai.com/api/v1/model-versions/123', 'json').hostname === 'civitai.com', 'metadata API paths restricted to read-only version lookup')
  check(allowedLoraUrl('https://civitai.com/api/v1/models/456', 'json').hostname === 'civitai.com', 'model-level tag lookup uses official read-only model API')
  const noTagsPath = path.join(root, 'no-tags.safetensors'), noTagsId = await model(noTagsPath)
  await fs.writeFile(noTagsPath.replace('.safetensors', '.json'), JSON.stringify({ id: 222, modelId: 333, baseModel: 'fixture', model: {}, images: [{ url: 'https://image.civitai.com/test.png' }] }))
  await fs.copyFile(pngPath, noTagsPath.replace('.safetensors', '.preview.png'))
  downloads = []
  restored.download = async (url, kind) => { downloads.push({ url, kind }); return Buffer.from(JSON.stringify({ id: 333, name: 'Tagged model', tags: ['Character', 'Style'] })) }
  await restored.fetch(noTagsId, { mode: 'missing' }); await restored.jobs.get(noTagsId).task
  check(restored.job(noTagsId).state === 'done' && downloads.length === 1 && downloads[0].url.endsWith('/models/333'), 'missing source tags fetch model metadata without replacing local preview')
  check((await restored.detail(noTagsId)).tags.includes('Character') && (await restored.list({ tags: JSON.stringify(['character', 'concept']) })).total === 2, 'fetched model tags support matching any selected category')
  restored.download = async () => Buffer.from('<html>not an image</html>')
  await restored.fetch(id); await restored.jobs.get(id).task
  check(restored.job(id).state === 'error' && restored.hasPreview(id), 'bad download surfaces error and preserves existing preview')
  const cachedBefore = await fs.readFile(restored.preview(missingId).real)
  restored.download = async () => Buffer.concat([png.subarray(0, 8), Buffer.from('broken PNG')])
  await restored.fetch(missingId); await restored.jobs.get(missingId).task
  check(restored.job(missingId).state === 'error' && (await fs.readFile(restored.preview(missingId).real)).equals(cachedBefore), 'Pillow rejects fake image signatures before replacing a good cached preview')
  const changedPath = path.join(root, 'changing.safetensors'), changedId = await model(changedPath)
  let completeChanged
  restored.download = async (url, kind) => kind === 'json' ? Buffer.from(JSON.stringify({ id: 12, images: [{ url: 'https://image.civitai.com/example.png' }] })) : new Promise(resolve => { completeChanged = () => resolve(png) })
  await restored.fetch(changedId); await until(() => completeChanged)
  await fs.appendFile(changedPath, Buffer.from('changed')); completeChanged(); await restored.jobs.get(changedId).task
  check(restored.job(changedId).state === 'error' && !restored.hasPreview(changedId), 'changed model identity prevents publishing metadata and preview for old weights')
  const token = 'fixture-token', handler = createHandler(store, {}, { token }, { loras: restored })
  server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const api = `http://127.0.0.1:${server.address().port}/comfyui-gallery/api/`
  const get = route => fetch(api + route)
  const post = (route, body, supplied = token) => fetch(api + route, { method: 'POST', headers: { 'x-gallery-token': supplied, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  check((await (await get('loras?q=cloudstyle')).json()).total === 1, 'HTTP LoRA listing searches local index')
  check((await (await get('loras/item?id=' + id)).json()).context.includes('cloudstyle'), 'HTTP detail exposes conversation context')
  check((await get('loras/thumb?id=' + id)).headers.get('content-type') === 'image/webp', 'HTTP thumbnail has correct content type')
  check((await post('loras/annotation', { id, patch: { favorite: false } }, 'wrong')).status === 403, 'LoRA mutations protected by random token')
  check((await fetch(api + 'loras/fetch', { method: 'HEAD' })).status === 405, 'HEAD cannot trigger network or model hashing')
  check((await post('loras/annotation', { id, patch: { favorite: false } })).status === 200 && !restored.mark(id).favorite, 'HTTP favorite update persists')
  check((await get('loras/thumb?id=' + outsideId)).status === 403, 'thumbnail route enforces model directory boundary')
  check((await get('loras/file?id=' + id)).status === 404, 'plugin does not expose raw weight download endpoint')
  await restored.close()
  loras = new Loras(store); await loras.ready; await loras.scan
  check((await loras.detail(missingId)).triggers[0] === 'newtrigger' && loras.hasPreview(missingId), 'fetched preview and metadata survive service reopen')
  await fs.writeFile(loras.annotationFile, 'broken')
  corrupt = new Loras(store); await corrupt.ready; await corrupt.scan
  await rejects(() => corrupt.annotate(id, { favorite: true }), 503)
  check(await fs.readFile(loras.annotationFile, 'utf8') === 'broken' && (await corrupt.list()).error, 'corrupt favorites preserved and surfaced')

  let client, slots = [], cursor = 0, fetchImpl
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }), useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] }, useRef: initial => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i] }, useEffect() {} }
  const source = (await fs.readFile('lib/client.js', 'utf8')).replace('exports.apply = apply', 'exports.__test = { attachLora, LoraPanel, LoraDetail, GalleryBody, Detail, ImageViewer }; exports.apply = apply')
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: m => { client = m.factory(() => react) } } }, fetch: (...args) => fetchImpl(...args), URLSearchParams, AbortController, DOMException, setTimeout, clearTimeout, console })
  let session = 'one', draft = 'existing text', rev = 1, focused = 0, panel = 'gallery', allow = true
  const binding = { ctx: {}, session: { getSnapshot: () => ({ subagent: null }) } }
  const actions = { captureInsertion: () => ({ draftRev: rev }), insertText: (value, span) => { if (!allow || span.draftRev !== rev) return false; draft += value; rev++; return true } }
  const ctx = { uiSession: { current: { getSnapshot: () => ({ key: session }) } }, sessions: { binding: () => binding }, conversation: { input: { for: () => ({ actions, focus: () => { focused++ } }) } }, layout: { selectPanel: value => { panel = value } } }
  fetchImpl = async () => ({ ok: true, json: async () => item })
  await client.__test.attachLora(ctx, id)
  check(draft.startsWith('existing text') && draft.includes('cloudstyle') && focused === 1 && panel === null, 'native text insertion preserves existing draft and returns to composer without sending')
  fetchImpl = async () => { session = 'other'; return { ok: true, json: async () => item } }
  await assert.rejects(() => client.__test.attachLora(ctx, id), /已切换/); checks++
  session = 'one'; fetchImpl = async () => { rev++; return { ok: true, json: async () => item } }
  await assert.rejects(() => client.__test.attachLora(ctx, id), /草稿已变化/); checks++
  fetchImpl = async () => ({ ok: true, json: async () => item }); allow = false
  await assert.rejects(() => client.__test.attachLora(ctx, id), /正在提交/); checks++
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(() => client.__test.attachLora(ctx, id, aborted.signal), /已取消/); checks++
  const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flatMap(nodes)] : []
  function render(name, props) { slots = []; cursor = 0; return client.__test[name](props) }
  check(nodes(render('GalleryBody', {})).some(n => n.type === 'button' && n.children[0] === 'LoRA 库'), 'gallery exposes independent LoRA library entry')
  check(nodes(render('LoraPanel', {})).some(n => n.props['aria-label'] === '搜索 LoRA'), 'LoRA browsing has search and accessible filters')
  check(nodes(render('LoraDetail', { item, chat() {} })).some(n => n.type === 'button' && n.children[0] === '添加 LoRA 到对话'), 'LoRA detail offers direct conversation insertion')
  check(nodes(render('Detail', { item: { id, name: 'fixture.png', mtime: Date.now(), size: 10, models: {}, loras: [], sampling: {}, nodes: [], groups: [], hasMetadata: false }, chat() {} })).some(n => n.type === 'button' && n.children[0] === '查看大图'), 'image detail offers a large-image viewer')
  console.log(JSON.stringify({ ok: true, checks, localMetadata: true, realThumbnail: true, networkMock: true, nativeDraftMock: true, modelsLoaded: false, screenshots: false, realConversationSent: false }))
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  await loras?.close(); await restored?.close(); await corrupt?.close(); await store?.close()
  await fs.rm(fixture, { recursive: true, force: true })
}
