// /delete endpoint test. Point GALLERY_LIB at a plugin tree to test that copy.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const base = (process.env.GALLERY_LIB || 'C:/Users/34721/Documents/Codex/2026-11-12/yued/work/gallery').replace(/\\/g, '/')
const lib = name => new URL(`lib/${name}`, `file:///${base}/`).href
const { GalleryStore, encodeId } = await import(lib('store.js'))
const { Library } = await import(lib('library.js'))
const { ThumbnailCache } = await import(lib('thumb.js'))
const { createHandler } = await import(lib('index.js'))

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-api-'))
const cache = path.join(root, '.cache')
await fsp.mkdir(cache, { recursive: true })
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
const write = async name => { await fsp.writeFile(path.join(root, name), PNG); return encodeId(path.join(root, name)) }
const one = await write('one.png')
const two = await write('two.png')
const stay = await write('stay.png')

const store = new GalleryStore({ roots: [root], cacheDir: cache })
const thumbs = new ThumbnailCache(store)
const library = new Library(store)
await store.ready
await library.ready
await store.refresh()

const token = 'test-token'
const handler = createHandler(store, thumbs, { token, forgetImage() {} }, { library, batches: {}, similarity: {}, reuse: {}, imports: {}, loras: {} })
const server = http.createServer((req, res) => handler(req, res))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const api = `http://127.0.0.1:${server.address().port}/comfyui-gallery/api`

const check = (label, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra ? ' :: ' + extra : '')); if (!ok) process.exitCode = 1 }
const post = (route, body, tok) => fetch(api + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { 'x-gallery-token': tok } : {}) }, body: JSON.stringify(body) })

let res = await post('/delete', { ids: [one] })
check('rejects request without token', res.status === 403, String(res.status))
check('file survives rejected request', fs.existsSync(path.join(root, 'one.png')))

res = await fetch(`${api}/delete?ids=${one}`)
check('rejects GET', res.status === 405, String(res.status))

res = await post('/delete', { ids: [] }, token)
check('rejects empty selection', res.status === 400, String(res.status))

res = await post('/delete', { ids: Array.from({ length: 201 }, () => one) }, token)
check('rejects more than 200 ids', res.status === 400, String(res.status))

res = await post('/delete', { ids: 'one.png' }, token)
check('rejects non-array ids', res.status === 400, String(res.status))

res = await post('/delete', { ids: [one, two, one] }, token)
const body = await res.json()
check('accepts batch delete', res.status === 200 && body.deleted.length === 2, JSON.stringify(body.deleted.map(d => d.name)))
check('deduplicates repeated ids', body.deleted.length === 2)
check('deleted files gone', !fs.existsSync(path.join(root, 'one.png')) && !fs.existsSync(path.join(root, 'two.png')))
check('unrelated image kept', fs.existsSync(path.join(root, 'stay.png')))
check('index reflects deletion', store.entries.size === 1, String(store.entries.size))

res = await fetch(`${api}/file?id=${one}`)
check('deleted image no longer served', res.status === 404, String(res.status))
res = await fetch(`${api}/file?id=${stay}`)
check('remaining image still served', res.status === 200, String(res.status))

res = await post('/delete', { ids: [one] }, token)
const second = await res.json()
check('deleting an already removed id reports a failure entry', second.deleted.length === 0 && second.failed.length === 1, JSON.stringify(second.failed[0].error))

server.close()
await store.close()
await fsp.rm(root, { recursive: true, force: true })
console.log('done')
