import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { GalleryStore, httpError } from './store.js'
import { ThumbnailCache } from './thumb.js'
import { Interrogator } from './interrogate.js'
import { Library } from './library.js'
import { Batches } from './batch.js'
import { Similarity } from './similarity.js'
import { Reuse } from './reuse.js'
import { UPLOAD_LIMIT } from './uploads.js'
import { Imports } from './imports.js'

// 版本号只从 package.json 读，避免代码里写死的副本与发布版本漂移。
const PLUGIN_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0' } catch { return '0.0.0' }
})()
import { Loras } from './loras.js'

export const name = 'dsh-comfyui-gallery'
export const inject = ['webServer']
export const Config = undefined
const PREFIX = '/comfyui-gallery/api'
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

async function jsonBody(req, limit = 16384) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw httpError(415, '请使用 JSON 请求')
  return new Promise((resolve, reject) => {
    let body = '', size = 0
    req.setEncoding('utf8')
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk)
      if (size > limit) { body = ''; reject(httpError(413, '请求内容过大')) }
      else body += chunk
    })
    req.on('error', reject)
    req.on('aborted', () => reject(httpError(400, '请求已中断')))
    req.on('end', () => {
      if (size > limit) return
      try { resolve(JSON.parse(body)) } catch { reject(httpError(400, 'JSON 格式错误')) }
    })
  })
}

export function createHandler(store, thumbs, interrogator, features = {}) {
  const { library, batches, similarity, reuse, imports, loras } = features
  return async (req, res) => {
    const send = (status, value, type = 'application/json; charset=utf-8') => {
      const body = typeof value === 'string' ? value : JSON.stringify(value)
      res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(req.method === 'HEAD' ? undefined : body)
    }
    try {
      const url = new URL(req.url, 'http://localhost')
      const route = url.pathname.slice(PREFIX.length)
      if (!url.pathname.startsWith(`${PREFIX}/`)) throw httpError(404, '接口不存在')
      if (route === '/interrogate/upload') {
        if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return send(405, { error: '请使用 POST 上传图片' }) }
        if (!interrogator) throw httpError(503, '反推服务未启用')
        if (req.headers['x-gallery-token'] !== interrogator.token) throw httpError(403, '请刷新工具列表后重试')
        if (!/^(application\/octet-stream|image\/(png|jpeg|webp|gif))(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw httpError(415, '请使用图片文件上传')
        if (Number(req.headers['content-length']) > UPLOAD_LIMIT) throw httpError(413, '图片应在 20 MB 以内')
        let size = 0, chunks = []
        const data = await new Promise((resolve, reject) => {
          req.on('data', chunk => { size += chunk.length; if (size > UPLOAD_LIMIT) { chunks = []; reject(httpError(413, '图片应在 20 MB 以内')) } else chunks.push(chunk) })
          req.on('error', reject); req.on('aborted', () => reject(httpError(400, '上传已中断')))
          req.on('end', () => { if (size <= UPLOAD_LIMIT) resolve(Buffer.concat(chunks)) })
        })
        let uploadName = '上传图片'
        try { uploadName = decodeURIComponent(req.headers['x-gallery-name'] || uploadName) } catch { throw httpError(400, '图片名称格式错误') }
        return send(201, await interrogator.upload(data, uploadName))
      }
      const actions = ['/annotation', '/delete', '/catalog/start', '/catalog/cancel', '/batch/start', '/batch/cancel', '/captions', '/similarity/start', '/similarity/cancel', '/reuse/prepare', '/reuse/export', '/reuse/submit', '/loras/annotation', '/loras/refresh', '/loras/fetch', '/loras/batch/start', '/loras/batch/cancel']
      const compute = ['/interrogate', '/interrogate/cancel', '/interrogate/upload/remove', '/interrogate/upload/release', '/interrogate/upload/save', '/interrogate/history/remove', ...actions].includes(route) && !(route === '/annotation' && ['GET', 'HEAD'].includes(req.method))
      if (compute) {
        if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return send(405, { error: '请使用 POST 启动或取消反推' }) }
        if (!interrogator) throw httpError(503, '反推服务未启用')
        // Custom header + an unguessable per-mount token prevent cross-site job submission.
        if (req.headers['x-gallery-token'] !== interrogator.token) throw httpError(403, '请刷新工具列表后重试')
        const body = await jsonBody(req, actions.includes(route) ? 262144 : 16384)
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, '请求格式错误')
        if (route.startsWith('/loras/')) {
          if (!loras) throw httpError(503, 'LoRA 管理未启用')
          if (route === '/loras/annotation') return send(200, await loras.annotate(body.id, body.patch))
          if (route === '/loras/refresh') return send(202, await loras.refresh())
          if (route === '/loras/fetch') return send(202, await loras.fetch(body.id, { mode: 'refresh' }))
          if (route === '/loras/batch/start') return send(202, await loras.startBatch(body))
          if (route === '/loras/batch/cancel') return send(200, loras.cancelBatch())
        }
        if (route === '/interrogate/upload/remove') return send(200, await interrogator.removeUpload(body.id))
        if (route === '/interrogate/upload/release') return send(200, await interrogator.releaseUpload(body.id))
        if (route === '/interrogate/history/remove') return send(200, await interrogator.removeHistory(body.jobId))
        if (route === '/interrogate/upload/save') {
          if (!imports) throw httpError(503, '图片保存功能未启用')
          return send(200, await imports.save(body))
        }
        if (route === '/interrogate' || route === '/interrogate/cancel') return send(route === '/interrogate' ? 202 : 200, route === '/interrogate' ? await interrogator.submit(body) : interrogator.cancel(body?.jobId))
        if (!library) throw httpError(503, '图库扩展功能未启用')
        await store.ready; await library.ready
        if (route === '/annotation') return send(200, await library.update(body.id, body.patch))
        if (route === '/delete') {
          const ids = body.ids
          if (!Array.isArray(ids) || !ids.length || ids.length > 200) throw httpError(400, '请选择 1–200 张图片删除')
          if (ids.some(value => typeof value !== 'string')) throw httpError(400, '图片 id 格式错误')
          const deleted = [], failed = []
          // Sequential on purpose: each file is unlinked and unindexed before the next,
          // so a partial failure never leaves the index pointing at a removed file.
          for (const id of [...new Set(ids)]) {
            try {
              const source = store.resolve(id)
              const result = await store.remove(id)
              await library.forget(id).catch(error => console.warn('[comfyui-gallery] forget:', error.message))
              await thumbs.discard(source).catch(() => {})
              interrogator.forgetImage(id)
              deleted.push({ id: result.id, name: result.name, removed: result.removed })
            } catch (error) { failed.push({ id, error: error.message || '删除失败' }) }
          }
          await store.flush().catch(error => console.warn('[comfyui-gallery] flush:', error.message))
          return send(200, { deleted, failed })
        }
        if (route === '/catalog/start') return send(202, await library.startIndex())
        if (route === '/catalog/cancel') return send(200, library.cancelIndex())
        if (route === '/batch/start') return send(202, await batches.start(body))
        if (route === '/batch/cancel') return send(200, batches.cancel(body.jobId))
        if (route === '/captions') return send(200, await library.captions(body.ids))
        if (route === '/similarity/start') return send(202, await similarity.start(body))
        if (route === '/similarity/cancel') return send(200, similarity.cancel())
        if (route === '/reuse/prepare') return send(200, await reuse.prepare(body.id))
        if (route === '/reuse/export') return send(200, await reuse.materialize(body))
        if (route === '/reuse/submit') return send(202, await reuse.submit(body))
      }
      if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('allow', 'GET, HEAD'); return send(405, { error: '仅支持 GET / HEAD' }) }
      const id = url.searchParams.get('id')
      if (route === '/features') {
        if (!library) throw httpError(503, '图库扩展功能未启用')
        const capability = await similarity.capability()
        return send(200, { token: interrogator.token, version: PLUGIN_VERSION, semantic: { ready: capability.ready, name: capability.name, reason: capability.reason } })
      }
      if (route.startsWith('/loras')) {
        if (!loras) throw httpError(503, 'LoRA 管理未启用')
        if (route === '/loras') return send(200, await loras.list(Object.fromEntries(url.searchParams)))
        if (route === '/loras/item') return send(200, await loras.detail(id))
        if (route === '/loras/job') { await loras.ready; return send(200, loras.job(id)) }
        if (route === '/loras/batch') { await loras.ready; return send(200, loras.batchStatus()) }
        if (route === '/loras/thumb') {
          await loras.ready
          const filename = await loras.thumbs.get(id), stat = fs.statSync(filename)
          res.writeHead(200, { 'content-type': 'image/webp', 'content-length': stat.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
          if (req.method === 'HEAD') return res.end()
          await pipeline(fs.createReadStream(filename), res); return
        }
      }
      if (route === '/facets' && library) return send(200, await library.facets())
      if (route === '/annotation' && library) {
        await library.ready
        const source = store.resolve(id), mark = library.get(id)
        return send(200, { ...mark, generated: mark.generated?.signature === store.signature(source.path, source.stat) ? mark.generated : undefined })
      }
      if (route === '/batch/job' && batches) return send(200, batches.status(id))
      if (route === '/similarity/job' && similarity) return send(200, similarity.view(Object.fromEntries(url.searchParams)))
      if (route === '/interrogate/history' && interrogator) return send(200, await interrogator.history(Object.fromEntries(url.searchParams)))
      if (route === '/interrogate/latest' && interrogator) {
        await interrogator.ready
        const latest = [...interrogator.jobs.values()].filter(job => job.imageId === id).sort((a, b) => b.createdAt - a.createdAt)[0]
        return send(200, latest ? interrogator.view(latest) : null)
      }
      if (route === '/interrogate/upload/current' && interrogator) return send(200, await interrogator.currentUpload(id))
      if (route === '/interrogate/upload/file' && interrogator) {
        await interrogator.ready
        const source = interrogator.uploads.resolve(id)
        res.writeHead(200, { 'content-type': source.mediaType, 'content-length': source.stat.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        if (req.method === 'HEAD') return res.end()
        await pipeline(fs.createReadStream(source.real), res)
        return
      }
      if (route === '/interrogate/tools' || route === '/interrogate/job') {
        if (!interrogator) throw httpError(503, '反推服务未启用')
        await interrogator.ready
        return send(200, route === '/interrogate/tools' ? await interrogator.tools() : interrogator.status(id))
      }
      if (route === '/health') return send(200, { ok: true, roots: store.config.roots, python: store.config.python, cacheDir: store.config.cacheDir, thumbCount: await thumbs.count() })
      if (route === '/list') return send(200, await store.list(Object.fromEntries(url.searchParams)))
      // Refresh is read-only and stays within the GET/HEAD contract.
      if (route === '/refresh') { await store.ready; return send(200, await store.refresh()) }
      if (route === '/item') return send(200, await store.detail(id))
      if (route === '/raw') return send(200, await store.raw(id, url.searchParams.get('kind')), 'text/plain; charset=utf-8')
      if (route === '/file' || route === '/thumb') {
        await store.ready
        const source = store.resolve(id)
        const filename = route === '/file' ? source.real : await thumbs.get(id)
        const stat = fs.statSync(filename)
        const etag = `"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`
        const headers = { 'content-type': route === '/thumb' ? 'image/webp' : TYPES[path.extname(source.path).toLowerCase()], 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff', etag, 'last-modified': stat.mtime.toUTCString() }
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end() }
        res.writeHead(200, { ...headers, 'content-length': stat.size })
        if (req.method === 'HEAD') return res.end()
        await pipeline(fs.createReadStream(filename), res)
        return
      }
      throw httpError(404, '接口不存在')
    } catch (error) {
      if (res.destroyed) return
      if (res.headersSent) { res.destroy(); return }
      const status = error.status || (error.code === 'ENOENT' ? 404 : 500)
      if (status === 500) console.warn('[comfyui-gallery]', error.message)
      send(status, { error: status === 500 ? '图库处理失败，请检查主进程日志' : error.message })
    }
  }
}

export function apply(ctx, config = {}) {
  // Defer configuration/index I/O until the effect has mounted, after apply returns.
  ctx.effect(() => {
    let store, thumbs, interrogator, handler, library, batches, similarity, reuse, imports, loras
    const initialize = () => { if (!store) {
      store = new GalleryStore(config); thumbs = new ThumbnailCache(store); library = new Library(store); store.library = library
      interrogator = new Interrogator(store); batches = new Batches(store, interrogator, library); similarity = new Similarity(store); reuse = new Reuse(store)
      imports = new Imports(store, interrogator, library)
      loras = new Loras(store)
      interrogator.onResult = async job => {
        if (job.imageId.startsWith('upload:')) return
        const source = store.resolve(job.imageId)
        if (store.signature(source.path, source.stat) !== store.signature(job.source.path, job.source.stat)) return
        await library.update(job.imageId, { text: job.result.text, tags: job.result.tags.map(t => t.tag), expectedSignature: store.signature(job.source.path, job.source.stat) }, true)
      }
      handler = createHandler(store, thumbs, interrogator, { library, batches, similarity, reuse, imports, loras })
    } }
    const timer = setTimeout(initialize, 0)
    const dispose = ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: (req, res) => { initialize(); return handler(req, res) } })
    console.log('[comfyui-gallery] mounted /comfyui-gallery/api')
    return () => {
      clearTimeout(timer); dispose(); reuse?.close(); thumbs?.close()
      const importsClosed = imports?.close(), batchesClosed = batches?.close(), similarityClosed = similarity?.close()
      ;(async () => { await importsClosed; await Promise.allSettled([batchesClosed, similarityClosed, interrogator?.close(), loras?.close()]); await library?.close(); await store?.close() })().catch(error => console.warn('[comfyui-gallery] close:', error.message))
    }
  }, 'comfyui-gallery: api')
}
