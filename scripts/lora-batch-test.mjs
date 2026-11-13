import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { Loras } from '../lib/loras.js'
import { GalleryStore, encodeId } from '../lib/store.js'
import { createHandler } from '../lib/index.js'

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-lora-batch-')), root = path.join(fixture, 'models')
const python = process.env.GALLERY_PYTHON || 'D:/Program Files/Comfy UI/python/python.exe'
const config = { roots: [], loraRoots: [root], python, cacheDir: path.join(fixture, 'cache'), thumbMax: 80, warmCount: 0 }
let checks = 0, service, reopened, store, server
const check = (value, label) => { assert.ok(value, label); checks++ }
const rejects = async (task, status) => { await assert.rejects(task, { status }); checks++ }
const until = async fn => { for (let i = 0; i < 500; i++) { if (await fn()) return; await sleep(10) }; throw new Error('timeout') }
async function model(name, version, preview = false) {
  const file = path.join(root, name + '.safetensors')
  await fs.mkdir(path.dirname(file), { recursive: true })
  const header = Buffer.from(JSON.stringify({ __metadata__: { 'modelspec.title': name }, tensor: { dtype: 'F32', shape: [1], data_offsets: [0, 4] } })), prefix = Buffer.alloc(8)
  prefix.writeBigUInt64LE(BigInt(header.length)); await fs.writeFile(file, Buffer.concat([prefix, header, Buffer.alloc(4)]))
  if (version) await fs.writeFile(file.replace('.safetensors', '.json'), JSON.stringify({ id: version, baseModel: 'fixture-base', model: { name: 'Local ' + name, tags: ['Style'] }, trainedWords: ['oldtrigger'], images: [{ url: 'https://image.civitai.com/test.png' }] }))
  if (preview) await fs.copyFile(path.join(fixture, 'sample.png'), file.replace('.safetensors', '.preview.png'))
  return encodeId(file)
}
try {
  const image = spawnSync(python, ['-c', "from PIL import Image; import sys; Image.new('RGB',(100,80),'blue').save(sys.argv[1])", path.join(fixture, 'sample.png')], { windowsHide: true, encoding: 'utf8' })
  assert.equal(image.status, 0, image.stderr)
  const png = await fs.readFile(path.join(fixture, 'sample.png')), ids = []
  for (let i = 0; i < 104; i++) ids.push(await model('Complete/item-' + String(i).padStart(3, '0'), 1000 + i, i < 103))
  const metaId = await model('Cases/metadata-only', 0, true), failureId = await model('Cases/image-failure', 0), forceId = ids[0]
  store = new GalleryStore(config); await store.ready
  service = new Loras(store); await service.ready; await service.scan
  let requests = []
  const version = (number = 7000, images = true) => Buffer.from(JSON.stringify({ id: number, name: 'new-version', baseModel: 'new-base', trainedWords: ['newtrigger'], model: { name: 'Updated model', tags: ['Style'] }, images: images ? [{ url: 'https://image.civitai.com/test.png' }] : [] }))
  service.download = async (url, kind) => { requests.push({ url, kind }); return kind === 'json' ? version() : png }
  const started = await service.startBatch({ filters: { folder: 'Complete' } })
  check(started.state === 'running' && started.total === 104, 'batch includes every filtered match beyond one page')
  await service.batch.task
  let status = service.batchStatus()
  check(status.state === 'done' && status.completed === 104 && status.skipped === 103 && status.succeeded === 1, 'missing mode skips complete local metadata and previews')
  check(requests.length === 1 && requests[0].kind === 'image', 'only missing preview downloads; complete files do not trigger hashing or network')
  const disk = JSON.parse(await fs.readFile(service.batchFile, 'utf8'))
  check(disk.job.total === 104 && disk.job.state === 'done' && !('controller' in disk.job), 'last batch progress saved without execution objects')
  requests = []; await service.startBatch({ filters: { folder: 'Complete' } }); await service.batch.task
  check(service.batchStatus().skipped === 104 && requests.length === 0, 'repeat missing mode reuses all completed results')
  await service.annotate(forceId, { favorite: true, categories: ['batch-fixture'], note: 'keep me' })
  const originalModel = await fs.readFile(service.resolve(forceId).real)
  const originalSidecar = await fs.readFile(service.resolve(forceId).path.replace('.safetensors', '.json'))
  requests = []; await service.startBatch({ mode: 'all', filters: { favorite: '1', category: 'batch-fixture', base: 'fixture-base' } }); await service.batch.task
  check(service.batchStatus().total === 1 && requests[0].kind === 'json' && requests.length >= 2 && requests.slice(1).every(r => r.kind === 'image'), 'refresh all respects combined filters and re-fetches both metadata and 1-3 preview images')
  check(requests[0].url.endsWith('/1000'), 'known version uses metadata lookup without full file hash')
  const refreshed = await service.detail(forceId)
  check(refreshed.triggers[0] === 'newtrigger' && refreshed.displayName === 'Updated model' && refreshed.base === 'new-base', 'newly fetched metadata updates displayed fields over older sidecar data')
  check(refreshed.favorite && refreshed.categories[0] === 'batch-fixture' && refreshed.note === 'keep me', 'refresh retains personal classification favorite and note')
  check((await fs.readFile(service.resolve(forceId).real)).equals(originalModel) && (await fs.readFile(service.resolve(forceId).path.replace('.safetensors', '.json'))).equals(originalSidecar), 'batch leaves model weights and manager sidecars intact')
  service.download = async (url, kind) => { requests.push({ url, kind }); return version(7001, false) }
  requests = []; await service.fetch(metaId, { mode: 'refresh' }); await service.jobs.get(metaId).task
  check(service.job(metaId).state === 'done' && service.job(metaId).warning && (await service.detail(metaId)).triggers[0] === 'newtrigger', 'metadata saved when public version has no image')
  check(service.hasPreview(metaId) && requests.length === 1, 'missing remote image preserves local preview without download')
  service.download = async (url, kind) => kind === 'json' ? version(7002) : Buffer.from('invalid image')
  await service.fetch(failureId, { mode: 'refresh' }); await service.jobs.get(failureId).task
  check(service.job(failureId).state === 'error' && (await service.detail(failureId)).triggers[0] === 'newtrigger', 'metadata persists separately when preview download is invalid')
  const cachedIndex = JSON.parse(await fs.readFile(service.cacheFile, 'utf8'))
  check(cachedIndex.items[failureId].value.versionId === 7002, 'metadata update persisted to incremental index immediately')
  await rejects(() => service.startBatch({ mode: 'invalid' }), 400)
  await rejects(() => service.startBatch({ filters: [] }), 400)
  let signalSeen
  service.download = async (url, kind, signal) => { signalSeen = signal; return new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('fixture cancelled')), { once: true }) }) }
  await service.startBatch({ mode: 'all', filters: { folder: 'Cases' } })
  await until(() => signalSeen)
  check(service.batchStatus().current && service.batchStatus().stage === '查询模型资料', 'batch status exposes current model and stage')
  await rejects(() => service.startBatch({}), 429)
  await rejects(() => service.fetch(forceId), 429)
  await rejects(() => service.refresh(), 429)
  check(service.cancelBatch().state === 'cancelling', 'cancel is accepted while download is active')
  await service.batch.task
  check(signalSeen.aborted && service.batchStatus().state === 'cancelled' && service.batchStatus().completed === 0, 'cancellation aborts active network and prevents later targets')
  check(service.cancelBatch().state === 'cancelled', 'repeated cancellation is harmless')
  const limitOne = await model('Rate/item1'), limitTwo = await model('Rate/item2')
  await service.refresh(); await service.scan
  requests = []; service.download = async () => { requests.push(1); throw Object.assign(new Error('rate limited'), { status: 429 }) }
  await service.startBatch({ mode: 'all', filters: { folder: 'Rate' } }); await service.batch.task
  check(service.batchStatus().state === 'error' && service.batchStatus().failed === 1 && requests.length === 1, 'rate limiting stops remaining batch requests immediately')
  requests = []; service.download = async () => { requests.push(1); throw Object.assign(new Error('not found'), { status: 404 }) }
  await service.startBatch({ mode: 'all', filters: { folder: 'Rate' } }); await service.batch.task
  check(service.batchStatus().state === 'done' && service.batchStatus().failed === 2 && service.batchStatus().errors.length === 2, 'missing public records are listed separately and next model continues')
  requests = []; service.download = async () => { requests.push(1); throw Object.assign(new Error('access restricted'), { status: 403 }) }
  await service.startBatch({ mode: 'all', filters: { folder: 'Rate' } }); await service.batch.task
  check(service.batchStatus().state === 'error' && requests.length === 1, 'access restrictions stop batch without repeated requests')
  const handler = createHandler(store, {}, { token: 'fixture-token' }, { loras: service })
  server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const api = `http://127.0.0.1:${server.address().port}/comfyui-gallery/api/`
  const post = (route, body, token = 'fixture-token') => fetch(api + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gallery-token': token }, body: JSON.stringify(body) })
  check((await post('loras/batch/start', {}, 'bad')).status === 403, 'batch start requires mutation token')
  check((await fetch(api + 'loras/batch/start', { method: 'HEAD' })).status === 405 && (await fetch(api + 'loras/batch/cancel')).status === 405, 'read requests do not start or cancel batches')
  const empty = await post('loras/batch/start', { filters: { q: 'no-such-fixture-model' } })
  check(empty.status === 202 && (await empty.json()).total === 0, 'HTTP zero match batch is accepted without any network work')
  await service.batch.task
  check((await (await fetch(api + 'loras/batch')).json()).state === 'done', 'HTTP status returns persisted batch result')
  check((await post('loras/batch/cancel', {})).status === 200, 'HTTP cancellation is idempotent after completion')
  await service.close()
  const last = JSON.parse(await fs.readFile(service.batchFile, 'utf8')); last.job.state = 'running'; await fs.writeFile(service.batchFile, JSON.stringify(last))
  reopened = new Loras(store); await reopened.ready; await reopened.scan
  check(reopened.batchStatus().state === 'interrupted' && !reopened.fetching(), 'service reopen marks unfinished batch interrupted instead of restarting network automatically')
  check((await reopened.detail(forceId)).triggers[0] === 'newtrigger' && reopened.hasPreview(forceId), 'completed metadata and preview survive reopening')
  check((await reopened.list({ missing: '1' })).items.every(item => !item.onlineMetadata || !item.preview), 'missing filter only includes incomplete metadata or previews')

  // Exercise user actions with a small hooks runner; no browser screenshots or real drafts.
  let client, slots = [], cursor = 0, calls = [], timers = [], effectQueue = [], cleanups = [], effectDeps = [], renders = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i] },
    useEffect(fn, deps) { const i = cursor++, key = JSON.stringify(deps); if (effectDeps[i] !== key) { effectDeps[i] = key; effectQueue.push(() => { cleanups[i]?.(); cleanups[i] = fn() }) } }
  }
  const listing = await reopened.list({ limit: 40 }), galleryListing = { total: 1, items: [{ id: 'image-id', name: 'image.png', mtime: Date.now() }], directories: [] }
  let viewJob = null
  const fetchMock = async (url, options) => {
    const parsed = new URL(url, 'http://fixture'), route = parsed.pathname.split('/api/')[1], body = options?.body ? JSON.parse(options.body) : null; calls.push({ route, body })
    const data = route === 'loras' ? listing : route === 'loras/batch' ? viewJob : route === 'loras/batch/start' ? (viewJob = { id: 'mock-job', state: 'running', total: 104, completed: 3, succeeded: 2, skipped: 1, failed: 0, errors: [] }) : route === 'features' ? { token: 'fixture-token' } : route === 'list' ? galleryListing : route === 'facets' ? { index: {}, tags: [], models: [], loras: [] } : {}
    return { ok: true, json: async () => data }
  }
  const source = (await fs.readFile('lib/client.js', 'utf8')).replace('exports.apply = apply', 'exports.__test = { LoraPanel, LoraFetchStatus, GalleryBody, installStyles }; exports.apply = apply')
  let injected
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: m => { client = m.factory(() => react) } } }, document: { querySelector: () => null, createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild: el => { injected = el.textContent } } }, fetch: fetchMock, URLSearchParams, AbortController, DOMException, setTimeout: fn => { timers.push(fn); return timers.length }, clearTimeout: () => {}, console })
  const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flatMap(nodes)] : []
  function render(name, props = {}) { cursor = 0; renders++; const tree = client.__test[name](props); for (const fn of effectQueue.splice(0)) fn(); return tree }
  function reset() { for (const cleanup of cleanups) cleanup?.(); slots = []; effectDeps = []; cleanups = []; timers = []; calls = []; viewJob = null }
  async function tick() { for (const fn of timers.splice(0)) fn(); await sleep(0) }
  let tree = render('LoraPanel', { token: 'fixture-token' }); await tick(); tree = render('LoraPanel', { token: 'fixture-token' })
  const find = (tree, test) => { const node = nodes(tree).find(test); assert.ok(node, 'missing UI node'); return node }
  check(!find(tree, n => n.type === 'button' && n.children[0] === '一键抓取').props.disabled, 'one click button enables after library loads')
  find(tree, n => n.props['aria-label'] === '搜索 LoRA').props.onChange({ target: { value: 'cloud' } })
  tree = render('LoraPanel', { token: 'fixture-token' })
  await find(tree, n => n.type === 'button' && n.children[0] === '一键抓取').props.onClick()
  await sleep(0)
  check(calls.find(c => c.route === 'loras/batch/start').body.filters.q === 'cloud', 'one click sends current search filter, not only visible IDs')
  tree = render('LoraPanel', { token: 'fixture-token' })
  check(find(tree, n => n.type === 'button' && n.children[0] === '后台抓取中…').props.disabled, 'running batch disables duplicate starts')
  reset(); tree = render('LoraPanel', { token: 'fixture-token' }); await tick(); tree = render('LoraPanel', { token: 'fixture-token' })
  find(tree, n => n.props['aria-label'] === '抓取范围').props.onChange({ target: { value: 'all' } })
  find(tree, n => n.props['aria-label'] === '抓取模式').props.onChange({ target: { value: 'all' } })
  tree = render('LoraPanel', { token: 'fixture-token' }); await find(tree, n => n.type === 'button' && n.children[0] === '一键抓取').props.onClick()
  const allCall = calls.find(c => c.route === 'loras/batch/start').body
  check(allCall.mode === 'all' && Object.keys(allCall.filters).length === 0, 'all-library mode explicitly ignores current filters')
  reset(); tree = render('LoraFetchStatus', { job: { id: 'job', state: 'running', completed: 3, total: 10, succeeded: 1, skipped: 1, failed: 1, current: { name: 'fixture' }, stage: '下载预览', errors: [{ name: 'broken', error: 'fixture error' }] }, cancel() {} })
  check(find(tree, n => n.type === 'progress').props.value === 3 && nodes(tree).some(n => n.type === 'button' && n.children[0] === '取消抓取'), 'progress exposes actual counts and cancellation action')
  check(nodes(tree).some(n => n.type === 'details'), 'failure details are expandable')
  reset(); tree = render('GalleryBody'); await tick(); tree = render('GalleryBody')
  check(nodes(tree).some(n => n.type === 'nav' && n.props['aria-label'] === '图库导航'), 'gallery has clear persistent navigation')
  check(!nodes(tree).some(n => n.type === 'button' && n.children[0] === '批量反推'), 'selection actions stay hidden until images are selected')
  find(tree, n => n.type === 'button' && n.children[0] === '选择已加载图片').props.onClick(); tree = render('GalleryBody')
  check(nodes(tree).some(n => n.type === 'button' && n.children[0] === '批量反推'), 'selecting images reveals batch actions')
  find(tree, n => n.type === 'button' && n.children[0] === 'LoRA 库').props.onClick(); tree = render('GalleryBody')
  check(!nodes(tree).some(n => n.props['aria-label'] === '图片筛选') && !nodes(tree).some(n => n.props.className === 'cg-selection-bar'), 'LoRA navigation frees space occupied by image filters and selection tools')
  find(tree, n => n.type === 'button' && n.children[0] === '图片').props.onClick(); tree = render('GalleryBody')
  check(nodes(tree).some(n => n.type === 'button' && n.children[0] === '批量反推'), 'returning to images preserves selection')
  client.__test.installStyles()
  check(injected.includes('@container(max-width:540px)') && injected.includes('prefers-reduced-motion') && injected.includes('--dsw-alias'), 'styles retain theme variables and narrow-window and reduced-motion support')
  reset()
  console.log(JSON.stringify({ ok: true, checks, crossPageTargets: 104, networkMock: true, metadataIndependentOfImage: true, uiActionsMock: true, screenshots: false, realConversationChanged: false }))
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  await service?.close(); await reopened?.close(); await store?.close()
  await fs.rm(fixture, { recursive: true, force: true })
}
