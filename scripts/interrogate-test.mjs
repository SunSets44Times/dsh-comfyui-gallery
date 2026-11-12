import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { GalleryStore, encodeId } from '../lib/store.js'
import { Interrogator, normalizeOptions } from '../lib/interrogate.js'
import { createHandler } from '../lib/index.js'

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-interrogate-'))
const root = path.join(fixture, 'images'), models = path.join(fixture, 'models')
await fs.mkdir(root); await fs.mkdir(models)
const image = path.join(root, 'fixture.png')
await fs.writeFile(image, 'fixture image; inference is mocked in queue tests')
await fs.writeFile(path.join(models, 'model.onnx'), 'fixture model')
await fs.writeFile(path.join(models, 'selected_tags.csv'), 'name,category\nlandscape,0')
await fs.writeFile(path.join(models, 'unpaired.onnx'), 'ignored')
const store = new GalleryStore({ roots: [root], cacheDir: path.join(fixture, 'cache'), wd14ModelDir: models, comfyRoot: path.join(fixture, 'no-comfy'), warmCount: 0,
  python: process.env.GALLERY_PYTHON || 'D:\\Program Files\\Comfy UI\\python\\python.exe' })
const runner = new Interrogator(store)
let server, checks = 0, calls = 0, active = 0, peak = 0
const check = (value, message) => { assert.ok(value, message); checks++ }
const reject = async (fn, status) => { await assert.rejects(fn, { status }); checks++ }
const waitFor = async (id, state) => {
  for (let i = 0; i < 300; i++) { const job = runner.status(id); if (job.state === state) return job; await sleep(5) }
  assert.fail(`job did not reach ${state}: ${JSON.stringify(runner.status(id))}`)
}
const result = { text: 'landscape, blue sky', tags: [{ tag: 'landscape', confidence: 0.9, category: 0 }], ratings: [], elapsedSec: 0.1, provider: 'CPU' }
try {
  await store.ready
  check(normalizeOptions().characterThreshold === 0.85, 'separate default character threshold')
  for (const options of [{ threshold: -1 }, { threshold: NaN }, { threshold: '' }, { excludeTags: 4 }, { sortAlpha: 'true' }, []]) {
    assert.throws(() => normalizeOptions(options), { status: 400 }); checks++
  }
  check((await runner.models()).length === 1, 'detect paired model/CSV and ignore unpaired models')
  // Exercise actual subprocess timeout and a real dependency probe without model inference.
  await assert.rejects(() => runner.runProcess(['--probe'], null, 1), /超时/); checks++
  check((await runner.tools()).tools[0].ready, 'Python dependencies detected locally')
  runner.runProcess = async (args, payload, timeout, job) => {
    if (args.includes('--probe')) return { ok: true }
    calls++; active++; peak = Math.max(peak, active)
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => payload.options.excludeTags === 'FAIL' ? reject(new Error('fixture inference error')) : resolve(result), 70)
        job.child = { kill() { clearTimeout(timer); reject(new Error('cancelled fixture')) } }
      })
    } finally { active-- }
  }
  const model = (await runner.models())[0].id
  const body = { id: encodeId(image), model, tool: 'wd14', options: {} }
  const pair = await Promise.all([runner.submit(body), runner.submit(body)])
  check(pair[0].jobId === pair[1].jobId, 'simultaneous requests coalesce before cache I/O completes')
  const done = await waitFor(pair[0].jobId, 'done')
  check(done.result.text === result.text && calls === 1, 'worker result and only one inference')
  const cached = await runner.submit(body)
  check(cached.state === 'done' && cached.cached && calls === 1, 'disk cache hit skips inference')
  const queued = await Promise.all([1, 2, 3, 4].map(n => runner.submit({ ...body, options: { threshold: n / 10 } })))
  check(queued.some(j => j.state === 'queued'), 'additional jobs wait in queue')
  runner.cancel(queued[1].jobId)
  check(runner.status(queued[1].jobId).state === 'cancelled', 'cancel queued job')
  runner.cancel(queued[0].jobId)
  check(runner.status(queued[0].jobId).state === 'cancelled', 'cancel running job')
  const replacement = await runner.submit({ ...body, options: { threshold: 0.1 } })
  const replacementAgain = await runner.submit({ ...body, options: { threshold: 0.1 } })
  check(replacement.jobId === replacementAgain.jobId, 'cancelled predecessor does not clear replacement dedup')
  await waitFor(queued[2].jobId, 'done'); await waitFor(queued[3].jobId, 'done'); await waitFor(replacement.jobId, 'done')
  check(peak === 1, 'at most one inference process')
  const failed = await runner.submit({ ...body, options: { excludeTags: 'FAIL' } })
  check((await waitFor(failed.jobId, 'error')).error === 'fixture inference error', 'worker errors surfaced')
  await reject(() => runner.submit({ ...body, id: encodeId(path.join(fixture, 'secret.png')) }), 403)
  await reject(() => runner.submit({ ...body, model: '../arbitrary.onnx' }), 400)
  const before = calls
  await fs.writeFile(image, 'image changed and cache must be invalidated')
  const changed = await runner.submit(body)
  await waitFor(changed.jobId, 'done')
  check(calls === before + 1 && !runner.status(changed.jobId).cached, 'image changes invalidate cached results')
  server = http.createServer(createHandler(store, { count: async () => 0 }, runner))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/comfyui-gallery/api/`
  const send = (route, value, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gallery-token': runner.token, ...headers }, body: JSON.stringify(value) })
  check((await fetch(base + 'interrogate')).status === 405, 'GET never launches inference')
  check((await send('interrogate', body, { 'x-gallery-token': 'wrong' })).status === 403, 'reject cross-site or stale token')
  check((await send('interrogate', body, { 'content-type': 'text/plain' })).status === 415, 'JSON content type required')
  check((await send('interrogate', { ...body, extra: 'a'.repeat(17000) })).status === 413, 'request size bound')
  check((await send('refresh', body)).status === 405, 'other APIs retain GET/HEAD contract')
  const accepted = await send('interrogate', body)
  check(accepted.status === 202 && (await accepted.json()).cached, 'POST returns job and cached result')
  const known = await fetch(base + 'interrogate/job?id=' + changed.jobId)
  check(known.status === 200 && (await known.json()).result.text === result.text, 'status endpoint returns completed result')
  check((await fetch(base + 'interrogate/job?id=missing')).status === 404, 'unknown job returns 404')
  const many = await Promise.all(Array.from({ length: 12 }, (_, n) => runner.submit({ ...body, options: { excludeTags: String(n) } }).then(value => value, e => e)))
  check(many.some(value => value.status === 429), 'queue bound includes jobs awaiting cache reads')
  await runner.close()
  check(many.filter(v => v.jobId).every(v => runner.status(v.jobId).state === 'cancelled'), 'unload cancels all pending jobs')
  await reject(() => runner.submit(body), 503)
  console.log(JSON.stringify({ ok: true, checks, inferenceCalls: calls, maxConcurrency: peak }))
} finally {
  await runner.close()
  if (server) await new Promise(resolve => server.close(resolve))
  await store.close()
  await sleep(30)
  await fs.rm(fixture, { recursive: true, force: true })
}
