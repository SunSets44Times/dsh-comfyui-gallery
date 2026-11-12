import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { GalleryStore, encodeId } from '../lib/store.js'
import { Interrogator } from '../lib/interrogate.js'
import { Uploads, imageType, UPLOAD_LIMIT } from '../lib/uploads.js'
import { createHandler } from '../lib/index.js'

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-uploads-'))
const root = path.join(fixture, 'images'), python = process.env.GALLERY_PYTHON || 'D:/Program Files/Comfy UI/python/python.exe'
let checks = 0, store, runner, server, extra
const check = (v, label) => { assert.ok(v, label); checks++ }
const rejects = async (fn, status) => { await assert.rejects(fn, { status }); checks++ }
const until = async fn => { for (let i = 0; i < 300; i++) { if (fn()) return; await sleep(10) }; throw new Error('test timeout') }
try {
  const made = spawnSync(python, ['scripts/features-fixture.py', root], { encoding: 'utf8', windowsHide: true }); assert.equal(made.status, 0, made.stderr)
  store = new GalleryStore({ roots: [root], cacheDir: path.join(fixture, 'cache'), python, warmCount: 0 }); await store.ready
  runner = new Interrogator(store)
  const png = await fs.readFile(path.join(root, 'landscape.png')), jpeg = await fs.readFile(path.join(root, 'landscape-copy.jpg'))
  check(imageType(png) === 'image/png' && imageType(jpeg) === 'image/jpeg', 'content signatures identify PNG/JPEG')
  check(imageType(Buffer.from('GIF89ax')) === 'image/gif' && imageType(Buffer.from('RIFFxxxxWEBP')) === 'image/webp', 'GIF/WebP signatures')
  assert.throws(() => imageType(Buffer.from('<svg/>')), { status: 415 }); checks++
  await rejects(() => runner.upload(Buffer.alloc(0)), 413)
  await rejects(() => runner.upload(Buffer.alloc(UPLOAD_LIMIT + 1)), 413)
  await rejects(() => runner.upload(Buffer.from('not an image')), 415)
  await rejects(() => runner.upload(png.subarray(0, 25)), 400)
  const uploaded = await runner.upload(png), other = await runner.upload(jpeg)
  check(uploaded.id.startsWith('upload:') && uploaded.width > 0 && uploaded.size === png.length, 'real Pillow validates image with opaque id')
  check(runner.resolveSource(uploaded.id).real.startsWith(runner.uploads.directory), 'uploaded source stays in dedicated temporary directory')
  assert.throws(() => store.resolve(uploaded.id)); checks++
  assert.throws(() => runner.resolveSource('upload:../../outside.png'), { status: 404 }); checks++
  await fs.appendFile(runner.resolveSource(other.id).real, 'changed')
  assert.throws(() => runner.resolveSource(other.id), { status: 409 }); checks++
  await runner.removeUpload(other.id)
  let calls = 0
  runner.models = async () => [{ id: 'mock', name: 'fixture model', signature: 'fixture' }]
  runner.runProcess = async () => { calls++; return { text: 'mountain, landscape', tags: [{ tag: 'mountain' }], ratings: [] } }
  let job = await runner.submit({ id: uploaded.id, model: 'mock', tool: 'wd14' })
  await until(() => runner.status(job.jobId).state === 'done')
  check(runner.status(job.jobId).result.text.includes('mountain') && calls === 1, 'uploaded image uses shared interrogation queue')
  check(!(await fs.readdir(runner.directory).catch(() => [])).length, 'temporary interrogation results do not persist to disk cache')
  const sourcePath = runner.resolveSource(uploaded.id).real
  await runner.removeUpload(uploaded.id)
  check(!(await fs.stat(sourcePath).catch(() => null)), 'explicit removal deletes temporary file')
  assert.throws(() => runner.status(job.jobId), { status: 404 }); checks++
  assert.throws(() => runner.resolveSource(uploaded.id), { status: 404 }); checks++
  await rejects(() => runner.removeUpload(encodeId(path.join(root, 'landscape.png'))), 400)
  extra = new Uploads(path.join(fixture, 'bounds'))
  await rejects(() => extra.add(png, async () => ({ width: 100000, height: 100000 })), 400)
  check(extra.reservations === 0 && extra.bytes === 0 && !(await fs.readdir(extra.directory)).length, 'failed validation frees reservations and files')
  extra.items = new Map(Array.from({ length: 20 }, (_, n) => [String(n), {}]))
  await rejects(() => extra.add(png, async () => ({})), 429); extra.items.clear()
  extra.reservations = 2; await rejects(() => extra.add(png, async () => ({})), 429); extra.reservations = 0
  extra.bytes = 100 * 1024 * 1024; await rejects(() => extra.add(png, async () => ({})), 429); extra.bytes = 0

  // Exercise raw upload transport without a real model run.
  runner.upload = data => runner.uploads.add(data, async () => ({ width: 640, height: 480 }))
  server = http.createServer(createHandler(store, {}, runner)); await new Promise(r => server.listen(0, '127.0.0.1', r))
  const api = `http://127.0.0.1:${server.address().port}/comfyui-gallery/api/`
  const post = (route, data, token = runner.token, type = 'application/octet-stream') => fetch(api + route, { method: 'POST', headers: { 'content-type': type, 'x-gallery-token': token }, body: data })
  check((await fetch(api + 'interrogate/upload', { method: 'HEAD' })).status === 405 && runner.uploads.items.size === 0, 'HEAD upload starts no work')
  check((await post('interrogate/upload', png, 'wrong')).status === 403, 'raw upload requires mount token')
  check((await post('interrogate/upload', png, runner.token, 'text/plain')).status === 415, 'raw upload validates content type')
  check((await post('interrogate/upload', Buffer.alloc(UPLOAD_LIMIT + 1))).status === 413, 'raw upload body bounded')
  const response = await post('interrogate/upload', png), viaHttp = await response.json()
  check(response.status === 201 && viaHttp.id.startsWith('upload:'), 'raw POST uploads image successfully')
  check((await post('interrogate/upload/remove', JSON.stringify({ id: viaHttp.id }), runner.token, 'application/json')).status === 200 && runner.uploads.items.size === 0, 'token protected POST removes upload')

  let client, slots = [], cursor = 0, fetchImpl, effectCleanups = []
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }), useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] }, useRef: initial => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i] }, useEffect: fn => { if (runEffects) { const cleanup = fn(); if (cleanup) effectCleanups.push(cleanup) } } }
  let runEffects = false, revoked = 0
  const fakeURL = { createObjectURL: () => 'blob:preview', revokeObjectURL: () => { revoked++ } }
  const source = (await fs.readFile('lib/client.js', 'utf8')).replace('exports.apply = apply', 'exports.__test = { attachImages, ConversationButton, UploadPanel, GalleryBody, Detail }; exports.apply = apply')
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: m => { client = m.factory(() => react) } } }, fetch: (...args) => fetchImpl(...args), URLSearchParams, URL: fakeURL, Blob, File, DOMException, AbortController, setTimeout, clearTimeout, console })
  const internal = client.__test
  function render(name, props, reset = false) { if (reset) slots = []; cursor = 0; return internal[name](props) }
  function nodes(tree) { return tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flatMap(nodes)] : [] }
  let sessionId = 'session-a', text = 'existing draft', attached = ['old-attachment'], staged = 0, released = 0, panel = 'gallery', focused = 0, allow = true
  const binding = { ctx: {}, session: { getSnapshot: () => ({ subagent: null }) } }
  const ctx = { uiSession: { current: { getSnapshot: () => ({ key: sessionId }) } }, sessions: { binding: id => id === 'session-a' ? binding : undefined }, conversation: { input: { for: () => ({ addAttachments: ids => { if (!allow) return false; attached.push(...ids); return true }, focus: () => { focused++ } }) }, createDrafts: (id, files, ordinary) => { check(id === 'session-a' && ordinary && files.every(f => f instanceof File && f.type === 'image/png'), 'native drafts receive File objects for captured session'); staged++; return files.map((f, i) => ({ id: 'native-' + i, file: f })) }, releaseDraftAttachments: () => { released++ } }, layout: { selectPanel: value => { panel = value } } }
  fetchImpl = async url => url.includes('/item?') ? { ok: true, json: async () => ({ name: '图片.png', size: png.length }) } : { ok: true, blob: async () => new Blob([png], { type: 'image/png' }) }
  check(await internal.attachImages(ctx, ['one', 'two']) === 2 && attached.join(',') === 'old-attachment,native-0,native-1' && text === 'existing draft' && panel === null && focused === 1, 'append preserves existing text and attachments, returns to composer, never submits')
  allow = false; await assert.rejects(() => internal.attachImages(ctx, ['one']), /正在提交/); checks++
  check(released === 1, 'locked composer releases newly staged attachments')
  allow = true
  fetchImpl = async url => url.includes('/item?') ? { ok: true, json: async () => ({ name: 'test.png', size: png.length }) } : { ok: true, blob: async () => { sessionId = 'session-b'; return new Blob([png], { type: 'image/png' }) } }
  const stagedBefore = staged
  await assert.rejects(() => internal.attachImages(ctx, ['one']), /已切换/); checks++
  check(staged === stagedBefore, 'session switch during file fetch creates no wrong-session attachments')
  await assert.rejects(() => internal.attachImages(ctx, []), /1–20/); checks++
  sessionId = 'session-a'
  fetchImpl = async () => ({ ok: true, json: async () => ({ name: 'large.png', size: 21 * 1048576 }) })
  await assert.rejects(() => internal.attachImages(ctx, ['one']), /20 MB/); checks++
  const cancelled = new AbortController(); cancelled.abort()
  fetchImpl = async url => url.includes('/item?') ? { ok: true, json: async () => ({ name: 'a.png', size: png.length }) } : { ok: true, blob: async () => new Blob([png], { type: 'image/png' }) }
  await assert.rejects(() => internal.attachImages(ctx, ['one'], cancelled.signal), /取消/); checks++
  check(nodes(render('GalleryBody', { chat: () => {} }, true)).some(n => n.type === 'button' && n.children[0] === '上传图片反推'), 'gallery exposes upload entry without selection')
  check(nodes(render('Detail', { item: { id: 'one', name: 'fixture', mtime: Date.now(), size: png.length } }, true)).some(n => n.type === internal.ConversationButton), 'detail exposes add to conversation entry')

  let uploadCalls = [], lastBody
  fetchImpl = async (url, options) => { if (url.includes('/current?')) return { ok: true, json: async () => null }; uploadCalls.push(url); lastBody = options.body; return { ok: true, json: async () => url.endsWith('/remove') ? { ok: true } : { id: 'upload:mock', width: 640, height: 480, size: png.length } } }
  runEffects = true
  let uploadTree = render('UploadPanel', { token: 'token' }, true)
  runEffects = false
  const picker = nodes(uploadTree).find(n => n.type === 'input' && n.props.type === 'file'), file = new File([png], 'external.png', { type: 'image/png' })
  picker.props.onChange({ target: { files: [file], value: 'external.png' } })
  await until(() => slots[0])
  check(lastBody === file && uploadCalls[0].endsWith('interrogate/upload'), 'upload picker sends binary external file')
  uploadTree = render('UploadPanel', { token: 'token' })
  check(nodes(uploadTree).some(n => n.type === 'img' && n.props.src === 'blob:preview') && nodes(uploadTree).some(n => n.props.expanded === true && n.props.id === 'upload:mock'), 'uploaded preview opens reusable interrogation controls')
  effectCleanups.forEach(fn => fn())
  check(revoked === 1 && uploadCalls.length === 1, 'panel disposal revokes preview and keeps server upload for background task')
  await runner.close()
  check(!!(await fs.stat(path.join(runner.uploads.directory, 'uploads.json'))), 'service disposal persists registered uploads for history')
  console.log(JSON.stringify({ ok: true, checks, nativeDraftMock: true, realImageValidation: true, realGeneration: false, screenshots: false }))
} finally {
  if (server) await new Promise(r => server.close(r))
  await runner?.close(); await extra?.close(); await store?.close()
  await fs.rm(fixture, { recursive: true, force: true })
}
