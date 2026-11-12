import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { GalleryStore, encodeId } from '../lib/store.js'
import { Interrogator } from '../lib/interrogate.js'
import { Library } from '../lib/library.js'
import { Imports } from '../lib/imports.js'
import { createHandler } from '../lib/index.js'

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-history-')), root = path.join(fixture, 'images')
const python = process.env.GALLERY_PYTHON || 'D:/Program Files/Comfy UI/python/python.exe'
let store, runner, restored, lastRunner, corrupt, library, imports, server, checks = 0
const check = (value, label) => { assert.ok(value, label); checks++ }
const rejects = async (fn, status) => { await assert.rejects(fn, { status }); checks++ }
const until = async fn => { for (let i = 0; i < 500; i++) { if (await fn()) return; await sleep(10) }; throw new Error('test timeout') }
try {
  const made = spawnSync(python, ['scripts/features-fixture.py', root], { encoding: 'utf8', windowsHide: true }); assert.equal(made.status, 0, made.stderr)
  const config = { roots: [root], cacheDir: path.join(fixture, 'cache'), python, warmCount: 0 }
  store = new GalleryStore(config); await store.ready
  runner = new Interrogator(store); await runner.ready
  const png = await fs.readFile(path.join(root, 'landscape.png')), upload = await runner.upload(png, '后台-山景.png')
  check(upload.name === '后台-山景.png', 'upload name retained for records')
  let finish, calls = 0
  runner.models = async () => [{ id: 'fixture-model', name: 'WD14 fixture', signature: 'fixture' }]
  runner.runProcess = async () => { calls++; return new Promise(resolve => { finish = () => resolve({ text: 'history unique mountain, blue sky', tags: [{ tag: 'mountain', confidence: 0.98 }], ratings: [], elapsedSec: 0.1 }) }) }
  const job = await runner.submit({ id: upload.id, tool: 'wd14', model: 'fixture-model' })
  await until(() => finish)
  check((await runner.history()).running === 1, 'history exposes in-progress background task')
  await runner.releaseUpload(upload.id)
  check(runner.status(job.jobId).state === 'running' && runner.uploads.resolve(upload.id).stat.size === png.length, 'leaving or replacing upload panel retains active task source')
  await rejects(() => runner.removeHistory(job.jobId), 409)
  server = http.createServer(createHandler(store, {}, runner))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const api = `http://127.0.0.1:${server.address().port}/comfyui-gallery/api/`
  const get = async (route, params = {}) => { const response = await fetch(api + route + '?' + new URLSearchParams(params)); assert.equal(response.status, 200); return response.json() }
  const post = (route, body, token = runner.token) => fetch(api + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gallery-token': token }, body: JSON.stringify(body) })

  // Mount the real upload component against the test HTTP service, then unmount it.
  let client, slots = [], cursor = 0, cleanups = [], useEffects = true, fetchCalls = []
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }), useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] }, useRef: initial => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i] }, useEffect: fn => { if (useEffects) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup) } } }
  const source = (await fs.readFile('lib/client.js', 'utf8')).replace('exports.apply = apply', 'exports.__test = { UploadPanel, HistoryPanel, GalleryBody, interrogationSessions }; exports.apply = apply')
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: m => { client = m.factory(() => react) } } }, fetch: (url, options) => { fetchCalls.push(url); return fetch(url.replace('/comfyui-gallery/api/', api), options) }, URLSearchParams, URL: { revokeObjectURL() {} }, AbortController, setTimeout, clearTimeout, console })
  const internal = client.__test, nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flatMap(nodes)] : []
  function render(name, props, reset = false) { if (reset) slots = []; cursor = 0; return internal[name](props) }
  let tree = render('UploadPanel', { token: runner.token }, true)
  useEffects = false; await until(() => slots[0])
  tree = render('UploadPanel', { token: runner.token })
  check(nodes(tree).some(node => node.type === 'img' && node.props.src.includes('interrogate/upload/file')), 'returning upload panel restores server image preview')
  check(internal.interrogationSessions.get(upload.id).state === 'running', 'remount restores current background job')
  cleanups.forEach(fn => fn()); cleanups = []
  check(!fetchCalls.some(url => url.includes('/remove') || url.includes('/cancel')), 'switching to conversation issues no delete or cancel request')
  finish(); await until(() => runner.status(job.jobId).state === 'done')
  check(runner.status(job.jobId).result.text.includes('history unique') && calls === 1, 'background completes after actual component unmount')
  const history = await get('interrogate/history', { q: 'history unique' })
  check(history.total === 1 && history.items[0].name === upload.name && !('result' in history.items[0]), 'history search returns paginated summaries without heavy result payload')
  check((await get('interrogate/history', { state: 'running' })).total === 0, 'history state filtering')
  check((await get('interrogate/latest', { id: upload.id })).jobId === job.jobId, 'latest job restored by image identity')
  check((await get('interrogate/upload/current', { id: upload.id })).job.state === 'done', 'upload descriptor provides completed result')
  const preview = await fetch(api + 'interrogate/upload/file?' + new URLSearchParams({ id: upload.id }))
  check(preview.status === 200 && preview.headers.get('content-type') === 'image/png' && Buffer.from(await preview.arrayBuffer()).equals(png), 'retained upload streaming preserves bytes')
  check((await fetch(api + 'interrogate/history/remove', { method: 'HEAD' })).status === 405, 'HEAD never deletes history')
  check((await post('interrogate/history/remove', { jobId: job.jobId }, 'wrong')).status === 403, 'history deletion protected by token')
  check((await fetch(api + 'interrogate/upload/file?id=upload:../../secret')).status === 404, 'retained file preview rejects arbitrary paths')
  await runner.close()
  const disk = JSON.parse(await fs.readFile(runner.historyFile, 'utf8'))
  check(disk.jobs[0].state === 'done' && disk.jobs[0].result.text === 'history unique mountain, blue sky', 'completed result persisted atomically on disk')
  restored = new Interrogator(store); await restored.ready
  check(restored.status(job.jobId).result.text === disk.jobs[0].result.text, 'history survives fresh Interrogator instance')
  check(restored.uploads.resolve(upload.id).stat.size === png.length, 'retained source survives service disposal and reopening')
  check((await restored.history()).items[0].sourceAvailable, 'restored record supports source preview')
  library = new Library(store); store.library = library; imports = new Imports(store, restored, library)
  const saved = await imports.save({ id: upload.id, jobId: job.jobId, name: upload.name })
  check((await library.captions([saved.id])).files[0].text === disk.jobs[0].result.text, 'restored uploaded history result can be saved into gallery')
  await imports.close(); await restored.close()
  lastRunner = new Interrogator(store); await lastRunner.ready
  imports = new Imports(store, lastRunner, library)
  check((await imports.save({ id: upload.id, jobId: job.jobId, name: upload.name })).id === saved.id, 'saved import remains idempotent after restart')
  await lastRunner.removeHistory(job.jobId)
  check((await lastRunner.history()).total === 0 && !lastRunner.uploads.items.has(upload.id), 'deleting final record frees retained source')
  check(store.resolve(saved.id).stat.size === png.length && library.get(saved.id).generated.text.includes('history unique'), 'record deletion preserves durable gallery import and caption')

  // Multiple jobs sharing one uploaded source keep the source until the final record is deleted.
  const shared = await lastRunner.upload(png, 'shared.png')
  const realProcess = lastRunner.runProcess.bind(lastRunner)
  lastRunner.models = runner.models
  lastRunner.runProcess = (args, ...rest) => args.length ? realProcess(args, ...rest) : Promise.resolve({ text: 'shared result', tags: [], ratings: [] })
  const sharedA = await lastRunner.submit({ id: shared.id, tool: 'wd14', model: 'fixture-model' }); await until(() => lastRunner.status(sharedA.jobId).state === 'done')
  const sharedB = await lastRunner.submit({ id: shared.id, tool: 'wd14', model: 'fixture-model', options: { threshold: 0.2 } }); await until(() => lastRunner.status(sharedB.jobId).state === 'done')
  await lastRunner.removeHistory(sharedA.jobId)
  check(lastRunner.uploads.items.has(shared.id), 'deleting one of multiple records keeps shared source')
  await lastRunner.removeHistory(sharedB.jobId)
  check(!lastRunner.uploads.items.has(shared.id), 'shared source freed after last record removed')
  const unused = await lastRunner.upload(png, 'unused.png'); await lastRunner.releaseUpload(unused.id)
  check(!lastRunner.uploads.items.has(unused.id), 'replacing an unused upload frees its storage')
  const originalId = encodeId(path.join(root, 'landscape.png'))
  const originalJob = await lastRunner.submit({ id: originalId, tool: 'wd14', model: 'fixture-model' }); await until(() => lastRunner.status(originalJob.jobId).state === 'done')
  await fs.rename(path.join(root, 'landscape.png'), path.join(root, 'moved.png'))
  check(!(await lastRunner.history()).items.find(row => row.jobId === originalJob.jobId).sourceAvailable && lastRunner.status(originalJob.jobId).result.text, 'missing gallery source retains prompt history')
  const sample = lastRunner.jobs.get(originalJob.jobId)
  for (let i = 0; i < 110; i++) {
    lastRunner.jobs.set('old-' + i, { ...sample, id: 'old-' + i, createdAt: i })
  }
  const bounded = await lastRunner.submit({ id: encodeId(path.join(root, 'moved.png')), tool: 'wd14', model: 'fixture-model' }); await until(() => lastRunner.status(bounded.jobId).state === 'done')
  check(lastRunner.jobs.size === 100 && (await lastRunner.history({ limit: 2 })).items.length === 2, 'history cap and pagination enforced')
  await lastRunner.close()
  const historyPath = lastRunner.historyFile, interrupted = JSON.parse(await fs.readFile(historyPath, 'utf8'))
  interrupted.jobs[0].state = 'running'; interrupted.jobs[0].jobId = 'interrupted'
  await fs.writeFile(historyPath, JSON.stringify(interrupted))
  restored = new Interrogator(store); await restored.ready
  check(restored.status('interrupted').state === 'error' && restored.status('interrupted').error.includes('上次退出'), 'interrupted task restores as explicit retryable error')
  await restored.close()
  const corruptConfig = { ...config, cacheDir: path.join(fixture, 'corrupt') }
  await fs.mkdir(corruptConfig.cacheDir); await fs.writeFile(path.join(corruptConfig.cacheDir, 'interrogate-history.json'), 'broken history')
  corrupt = new Interrogator({ ...store, config: corruptConfig }); await corrupt.ready
  await rejects(() => corrupt.submit({ id: originalId, tool: 'wd14', model: 'fixture-model' }), 503)
  check((await corrupt.history()).error && await fs.readFile(corrupt.historyFile, 'utf8') === 'broken history', 'corrupt history preserved and visible')
  await corrupt.close()
  useEffects = false
  check(nodes(render('GalleryBody', {}, true)).some(node => node.type === 'button' && node.children[0] === '反推记录'), 'gallery exposes standalone history entry')
  tree = render('HistoryPanel', { token: 'token' }, true)
  check(nodes(tree).some(node => node.props['aria-label'] === '搜索反推记录') && nodes(tree).some(node => node.props['aria-label'] === '反推状态'), 'history UI has search and status filter')
  console.log(JSON.stringify({ ok: true, checks, unmountedBackgroundCompleted: true, historyRestartPersistence: true, retainedUploadPreview: true, screenshots: false, realGeneration: false }))
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  await imports?.close(); await runner?.close(); await restored?.close(); await lastRunner?.close(); await corrupt?.close(); await library?.close(); await store?.close()
  await fs.rm(fixture, { recursive: true, force: true })
}
