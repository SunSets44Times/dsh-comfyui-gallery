import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { GalleryStore, encodeId } from '../lib/store.js'
import { Library } from '../lib/library.js'
import { Interrogator } from '../lib/interrogate.js'
import { Imports } from '../lib/imports.js'
import { createHandler } from '../lib/index.js'

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-imports-')), root = path.join(fixture, 'images')
const python = process.env.GALLERY_PYTHON || 'D:/Program Files/Comfy UI/python/python.exe'
let checks = 0, store, library, runner, imports, server, restored, restoredLibrary
const check = (value, label) => { assert.ok(value, label); checks++ }
const rejects = async (fn, status) => { await assert.rejects(fn, { status }); checks++ }
try {
  const made = spawnSync(python, ['scripts/features-fixture.py', root], { encoding: 'utf8', windowsHide: true }); assert.equal(made.status, 0, made.stderr)
  const gifMade = spawnSync(python, ['-c', 'from PIL import Image; import sys; a=Image.new("RGB",(64,48),"red"); b=Image.new("RGB",(64,48),"blue"); a.save(sys.argv[1],save_all=True,append_images=[b],duration=100,loop=0)', path.join(fixture, 'animated.gif')], { encoding: 'utf8', windowsHide: true }); assert.equal(gifMade.status, 0, gifMade.stderr)
  const config = { roots: [root], cacheDir: path.join(fixture, 'cache'), python, warmCount: 0 }
  store = new GalleryStore(config); await store.ready; await store.refresh()
  library = new Library(store); store.library = library; runner = new Interrogator(store); imports = new Imports(store, runner, library)
  const png = await fs.readFile(path.join(root, 'landscape.png')), jpeg = await fs.readFile(path.join(root, 'landscape-copy.jpg'))
  const upload = await runner.upload(png)
  function doneJob(item, text = 'import-test mountain, sunrise') {
    const job = { id: randomUUID(), imageId: item.id, state: 'done', source: runner.resolveSource(item.id), model: { name: 'fixture WD14' }, options: { threshold: 0.35, characterThreshold: 0.85 }, result: { text, tags: [{ tag: 'mountain', confidence: 0.95 }], ratings: [], provider: 'CPU' } }
    runner.jobs.set(job.id, job); return job
  }
  const job = doneJob(upload), body = { id: upload.id, jobId: job.id, name: '../../同名图片.png', text: 'untrusted caption' }
  await rejects(() => imports.save({ ...body, id: encodeId(path.join(root, 'landscape.png')) }), 400)
  await rejects(() => imports.save({ ...body, jobId: 'missing' }), 400)
  job.state = 'running'; await rejects(() => imports.save(body), 409); job.state = 'done'
  await rejects(() => imports.save({ ...body, name: {} }), 400)
  const saved = await Promise.all([imports.save(body), imports.save(body)])
  check(saved[0].id === saved[1].id, 'simultaneous save requests coalesce to one durable image')
  const result = saved[0], resolved = store.resolve(result.id), target = path.dirname(resolved.path)
  check(path.relative(root, resolved.path).startsWith('图库导入' + path.sep) && result.name === '同名图片.png', 'name traversal discarded and destination stays in current gallery root')
  check((await fs.readFile(resolved.path)).equals(png), 'PNG original bytes and embedded metadata preserved')
  check(await fs.readFile(resolved.path.replace(/\.png$/, '.txt'), 'utf8') === job.result.text, 'caption TXT uses trusted completed job, ignoring browser caption')
  const sidecar = JSON.parse(await fs.readFile(resolved.path.replace(/\.png$/, '.json'), 'utf8'))
  check(sidecar.galleryImport.model === job.model.name && sidecar.galleryImport.result.text === job.result.text && sidecar.galleryImport.options.threshold === 0.35, 'sidecar persists caption, confidence, model and options')
  check((await store.detail(result.id)).positive === 'mountain sunrise' && library.get(result.id).generated.text === job.result.text, 'original embedded prompt and imported interrogation result remain distinct')
  check((await store.list({ q: 'import-test' })).items.some(item => item.id === result.id), 'saved prompt immediately searchable')
  check((await library.captions([result.id])).files[0].text === job.result.text, 'saved upload participates in caption export')
  check((await imports.save(body)).id === result.id && (await fs.readdir(path.join(root, '图库导入'))).length === 1, 'retry after successful response creates no duplicate')
  const second = doneJob(upload, 'a different interrogation result'), other = await imports.save({ ...body, jobId: second.id })
  check(other.id !== result.id && library.get(other.id).generated.text === second.result.text, 'new interrogation result is saved separately without overwriting prior result')
  const jpgUpload = await runner.upload(jpeg), jpgJob = doneJob(jpgUpload)
  const jpg = await imports.save({ id: jpgUpload.id, jobId: jpgJob.id, name: 'CON.png' })
  check(jpg.name === '上传图片.jpg' && (await fs.readFile(store.resolve(jpg.id).path)).equals(jpeg), 'extension follows actual file format and Windows reserved name sanitized')
  check((await store.detail(jpg.id)).positive === jpgJob.result.text, 'sidecar prompt shown when original has no embedded metadata')
  const gifUpload = await runner.upload(await fs.readFile(path.join(fixture, 'animated.gif'))), gifJob = doneJob(gifUpload)
  const gif = await imports.save({ id: gifUpload.id, jobId: gifJob.id, name: 'animated.gif' }), gifPath = store.resolve(gif.id).path
  check(gif.firstFrame && gif.name === 'animated.png' && (await store.detail(gif.id)).width === 64, 'GIF saved as gallery-compatible PNG with dimensions')
  const pixel = spawnSync(python, ['-c', 'from PIL import Image; import sys; im=Image.open(sys.argv[1]); print(im.convert("RGB").getpixel((0,0)))', gifPath], { encoding: 'utf8', windowsHide: true })
  check(pixel.status === 0 && pixel.stdout.trim() === '(255, 0, 0)', 'GIF export uses actual first frame')
  await runner.removeUpload(upload.id)
  check((await fs.readFile(resolved.path)).equals(png) && (await library.captions([result.id])).files.length === 1, 'temporary upload removal retains durable image and caption')

  const stage = path.join(root, '图库导入', '.gallery-import-test'); await fs.mkdir(stage); await fs.writeFile(path.join(stage, 'partial.png'), png)
  await store.refresh()
  check(!store.entries.has(path.join(stage, 'partial.png')), 'unfinished imports never appear in scans')
  await fs.rm(stage, { recursive: true })
  const beforeNames = (await fs.readdir(path.join(root, '图库导入'))).sort(), beforeCount = store.entries.size
  const failing = doneJob(jpgUpload), update = library.update
  library.update = async () => { throw Object.assign(new Error('simulated full disk'), { status: 503 }) }
  await rejects(() => imports.save({ id: jpgUpload.id, jobId: failing.id, name: 'rollback.jpg' }), 503)
  library.update = update
  check(JSON.stringify((await fs.readdir(path.join(root, '图库导入'))).sort()) === JSON.stringify(beforeNames) && store.entries.size === beforeCount, 'annotation write failure rolls back image and both companions')
  check((await imports.save({ id: jpgUpload.id, jobId: failing.id, name: 'retry.jpg' })).name === 'retry.jpg', 'failed save can be retried')

  // An existing junction must not redirect imports outside the configured roots.
  const importDir = path.join(root, '图库导入'), moved = path.join(root, 'previous-imports'), outside = path.join(fixture, 'outside')
  await fs.mkdir(outside); await fs.rename(importDir, moved)
  await fs.symlink(outside, importDir, process.platform === 'win32' ? 'junction' : 'dir')
  try { const linked = doneJob(jpgUpload); await rejects(() => imports.save({ id: jpgUpload.id, jobId: linked.id, name: 'outside.jpg' }), 403); check(!(await fs.readdir(outside)).length, 'junction escape writes no outside files') }
  finally { await fs.unlink(importDir); await fs.rename(moved, importDir) }

  server = http.createServer(createHandler(store, {}, runner, { library, imports })); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const api = `http://127.0.0.1:${server.address().port}/comfyui-gallery/api/`, route = api + 'interrogate/upload/save'
  const httpJob = doneJob(jpgUpload), httpBody = { id: jpgUpload.id, jobId: httpJob.id, name: 'http.jpg' }
  const post = (token, content = httpBody) => fetch(route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gallery-token': token }, body: JSON.stringify(content) })
  check((await fetch(route, { method: 'HEAD' })).status === 405, 'HEAD starts no import')
  check((await post('wrong')).status === 403, 'save endpoint requires mount token')
  check((await post(runner.token, { ...httpBody, id: 'upload:missing' })).status === 400, 'HTTP mismatched result rejected')
  const response = await post(runner.token), viaHttp = await response.json()
  check(response.status === 200 && (await store.detail(viaHttp.id)).name === 'http.jpg', 'token protected save endpoint publishes image')

  await library.close(); await store.close()
  restored = new GalleryStore(config); restoredLibrary = new Library(restored); restored.library = restoredLibrary
  await restored.ready; await restored.refresh(); await restoredLibrary.ready
  check((await restored.list({ q: 'import-test' })).items.some(item => item.id === result.id) && restoredLibrary.get(result.id).generated.text === job.result.text, 'image and searchable caption survive a new store and library instance')
  check((await fs.readdir(target)).length === 3, 'durable directory contains image plus TXT and JSON')

  let client, slots = [], cursor = 0, fetchImpl
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }), useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] }, useRef: value => { const i = cursor++; if (!(i in slots)) slots[i] = { current: value }; return slots[i] }, useEffect: () => {} }
  const source = (await fs.readFile('lib/client.js', 'utf8')).replace('exports.apply = apply', 'exports.__test = { SaveToGallery, Interrogate, interrogationSessions }; exports.apply = apply')
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: m => { client = m.factory(() => react) } } }, fetch: (...args) => fetchImpl(...args), URLSearchParams, AbortController, setTimeout, clearTimeout, console })
  const internal = client.__test, nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flatMap(nodes)] : []
  function render(name, props, reset = false) { if (reset) slots = []; cursor = 0; return internal[name](props) }
  const viewJob = { jobId: 'job', state: 'done', model: 'model', options: { threshold: 0.35, characterThreshold: 0.85 }, result: { text: 'mountain', tags: [], ratings: [] } }
  internal.interrogationSessions.set('upload:test', viewJob)
  check(nodes(render('Interrogate', { id: 'upload:test', downloadName: 'test.png', expanded: true }, true)).some(n => n.type === internal.SaveToGallery), 'completed upload result exposes save component')
  internal.interrogationSessions.set('upload:test', { ...viewJob, state: 'running' })
  check(!nodes(render('Interrogate', { id: 'upload:test', downloadName: 'test.png' }, true)).some(n => n.type === internal.SaveToGallery), 'save hidden until interrogation completes')
  internal.interrogationSessions.set('gallery:test', viewJob)
  check(!nodes(render('Interrogate', { id: 'gallery:test' }, true)).some(n => n.type === internal.SaveToGallery), 'existing gallery image has no duplicate import action')
  let requests = 0, changed = 0, opened, finish, received
  const props = { id: 'upload:test', jobId: 'job', name: 'test.png', token: 'token', saved: () => { changed++ }, open: id => { opened = id } }
  fetchImpl = async (url, options) => { requests++; received = JSON.parse(options.body); await new Promise(resolve => { finish = resolve }); return { ok: true, json: async () => ({ id: 'durable', firstFrame: false }) } }
  let tree = render('SaveToGallery', props, true), click = nodes(tree).find(n => n.type === 'button').props.onClick
  const saving = click(); await click()
  check(requests === 1 && !('text' in received) && received.jobId === props.jobId, 'client locks duplicate clicks and sends job identity, not caption')
  finish(); await saving; tree = render('SaveToGallery', props)
  const buttons = nodes(tree).filter(n => n.type === 'button')
  check(buttons[0].props.disabled && buttons[0].children[0] === '已保存到图库' && changed === 1, 'successful save acknowledges persistence and refreshes gallery')
  buttons[1].props.onClick(); check(opened === 'durable', 'view saved image opens durable gallery ID')
  fetchImpl = async () => ({ ok: false, json: async () => ({ error: '保存失败，请重试' }) })
  tree = render('SaveToGallery', props, true); await nodes(tree).find(n => n.type === 'button').props.onClick(); tree = render('SaveToGallery', props)
  check(nodes(tree).some(n => n.props.role === 'alert') && !nodes(tree).find(n => n.type === 'button').props.disabled, 'save error shown with retry available')
  await imports.close(); await rejects(() => imports.save(httpBody), 503)
  console.log(JSON.stringify({ ok: true, checks, realImageValidation: true, gifFirstFrame: true, persistentImport: true, realGeneration: false, screenshots: false }))
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  await imports?.close(); await runner?.close(); await library?.close(); await store?.close(); await restoredLibrary?.close(); await restored?.close()
  await fs.rm(fixture, { recursive: true, force: true })
}
