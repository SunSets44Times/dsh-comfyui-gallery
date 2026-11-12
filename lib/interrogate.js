import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { httpError } from './store.js'
import { Uploads } from './uploads.js'

const digest = value => createHash('sha256').update(value).digest('hex')
const script = fileURLToPath(new URL('../scripts/interrogate.py', import.meta.url))
const isFile = async name => { try { return (await fs.stat(name)).isFile() } catch { return false } }

export function normalizeOptions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, '反推参数格式错误')
  const number = (key, fallback) => {
    const n = value[key] ?? fallback
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) throw httpError(400, `${key} 应在 0–1 之间`)
    return n
  }
  const boolean = (key, fallback) => {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw httpError(400, `${key} 应为布尔值`)
    return value[key] ?? fallback
  }
  const excludeTags = value.excludeTags ?? ''
  if (typeof excludeTags !== 'string' || excludeTags.length > 4096) throw httpError(400, '排除标签过长')
  return { threshold: number('threshold', 0.35), characterThreshold: number('characterThreshold', 0.85),
    excludeTags, sortAlpha: boolean('sortAlpha', false), replaceUnderscore: boolean('replaceUnderscore', true),
    escapeBrackets: boolean('escapeBrackets', true), includeConfidence: boolean('includeConfidence', false) }
}

export class Interrogator {
  constructor(store) {
    this.store = store
    this.token = randomBytes(32).toString('hex')
    this.directory = path.join(store.config.cacheDir, 'interrogate')
    this.uploads = new Uploads(store.config.cacheDir, true)
    this.historyFile = path.join(store.config.cacheDir, 'interrogate-history.json')
    this.serial = Promise.resolve()
    this.jobs = new Map()
    this.pending = new Map()
    this.queue = []
    this.active = null
    this.closed = false
    this.children = new Set()
    this.probe = null
    this.probeTime = 0
    const timeout = Number(store.config.interrogateTimeoutMs)
    this.timeout = Number.isFinite(timeout) ? Math.max(10000, Math.min(timeout, 600000)) : 180000
    this.ready = this.loadHistory()
  }
  async loadHistory() {
    await this.uploads.ready
    try {
      const saved = JSON.parse(await fs.readFile(this.historyFile, 'utf8'))
      if (saved.version !== 1 || !Array.isArray(saved.jobs)) throw new Error('反推记录格式错误')
      for (const value of saved.jobs.slice(-100)) {
        if (typeof value.jobId !== 'string' || typeof value.imageId !== 'string' || !['done', 'error', 'cancelled', 'queued', 'running'].includes(value.state)) continue
        let source
        try { source = this.resolveSource(value.imageId) } catch { /* history text survives a removed original */ }
        const interrupted = ['queued', 'running'].includes(value.state)
        this.jobs.set(value.jobId, { id: value.jobId, imageId: value.imageId, name: value.name, createdAt: value.createdAt, completedAt: value.completedAt,
          state: interrupted ? 'error' : value.state, error: interrupted ? '上次退出时任务尚未完成，可重新反推' : value.error,
          result: value.result, options: value.options, model: { name: value.model, id: value.modelId }, source, cached: value.cached, savedImport: value.savedImport })
      }
    } catch (error) { if (error.code !== 'ENOENT') { this.historyError = error; console.warn('[gallery] interrogation history:', error.message) } }
  }
  persistHistory() {
    const task = this.serial.then(async () => {
      if (this.historyError) throw httpError(503, '反推记录读取异常，已保留原文件，请检查 interrogate-history.json')
      await fs.mkdir(path.dirname(this.historyFile), { recursive: true })
      const temp = this.historyFile + '.' + randomUUID() + '.tmp'
      try { await fs.writeFile(temp, JSON.stringify({ version: 1, jobs: [...this.jobs.values()].map(job => this.view(job)) })); await fs.rename(temp, this.historyFile) }
      finally { await fs.rm(temp, { force: true }).catch(() => {}) }
    })
    this.serial = task.catch(() => {})
    return task
  }
  remember() { return this.persistHistory().catch(error => { this.writeError = error.message; console.warn('[gallery] history save:', error.message) }) }
  async history(params = {}) {
    await this.ready
    const q = String(params.q || '').trim().toLowerCase(), state = params.state || ''
    const all = [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt)
    const filtered = all.filter(job => (!state || job.state === state) && (!q || `${job.name || ''}\n${job.result?.text || ''}\n${job.model.name}`.toLowerCase().includes(q)))
    const offset = Math.max(0, Math.floor(Number(params.offset) || 0)), limit = Math.max(1, Math.min(50, Math.floor(Number(params.limit) || 20)))
    return { total: filtered.length, running: all.filter(job => ['queued', 'running'].includes(job.state)).length, offset, limit,
      error: this.historyError?.message || this.writeError || '', items: filtered.slice(offset, offset + limit).map(job => {
        let sourceAvailable = false
        try { this.resolveSource(job.imageId); sourceAvailable = true } catch { /* optional image */ }
        const view = this.view(job)
        return { ...view, sourceAvailable, excerpt: job.result?.text?.slice(0, 300), result: undefined }
      }) }
  }
  async removeHistory(id) {
    await this.ready
    const job = this.jobs.get(id)
    if (!job) throw httpError(404, '记录不存在')
    if (['queued', 'running'].includes(job.state)) throw httpError(409, '请先取消任务，再删除记录')
    this.jobs.delete(id)
    try { await this.persistHistory() } catch (error) { this.jobs.set(id, job); throw error }
    if (job.imageId.startsWith('upload:') && ![...this.jobs.values()].some(other => other.imageId === job.imageId)) await this.uploads.remove(job.imageId)
    return { ok: true }
  }
  async models() {
    const comfy = this.store.config.comfyRoot || path.join(path.dirname(path.dirname(this.store.config.python)), 'ComfyUI')
    const dirs = [this.store.config.wd14ModelDir, path.join(comfy, 'custom_nodes', 'ComfyUI-WD14-Tagger', 'models')].filter(p => typeof p === 'string' && path.isAbsolute(p))
    const pairs = []
    for (const dir of [...new Set(dirs)]) {
      let names
      try { names = await fs.readdir(dir) } catch { continue }
      for (const name of names.filter(n => n.toLowerCase().endsWith('.onnx')).slice(0, 32)) {
        const model = path.join(dir, name)
        const labels = path.join(dir, name.toLowerCase() === 'model.onnx' ? 'selected_tags.csv' : name.replace(/\.onnx$/i, '.csv'))
        if (!await isFile(model) || !await isFile(labels)) continue
        const modelStat = await fs.stat(model), csvStat = await fs.stat(labels)
        pairs.push({ id: digest(model).slice(0, 20), name: name === 'model.onnx' ? path.basename(dir) : name.replace(/\.onnx$/i, ''),
          model, labels, signature: `${model}:${modelStat.size}:${modelStat.mtimeMs}:${csvStat.size}:${csvStat.mtimeMs}` })
      }
    }
    return pairs
  }
  async tools() {
    await this.ready
    if (this.closed) throw httpError(503, '图库正在重载')
    const models = await this.models()
    if (!this.probe || Date.now() - this.probeTime > 120000) {
      this.probeTime = Date.now()
      this.probe = this.runProcess(['--probe'], null, 10000).catch(error => ({ ok: false, error: error.message }))
    }
    const probe = await this.probe
    return { token: this.token, tools: [{ id: 'wd14', name: 'WD14 标签反推', ready: !!models.length && probe.ok,
      reason: !models.length ? '尚未找到配套的本地 ONNX 模型和 CSV 标签表' : !probe.ok ? probe.error || `Python 缺少：${probe.missing.join('、')}` : '',
      models: models.map(({ id, name }) => ({ id, name })), provider: 'CPU' }] }
  }
  view(job) {
    return { jobId: job.id, imageId: job.imageId, state: job.state, createdAt: job.createdAt,
      name: job.name || path.basename(job.source?.path || '图片'), completedAt: job.completedAt, options: job.options, model: job.model.name, modelId: job.model.id,
      result: job.result, error: job.error, cached: !!job.cached, savedImport: job.savedImport }
  }
  status(id) {
    const job = this.jobs.get(id)
    if (!job) throw httpError(404, '任务已过期，请重新反推（已有结果可从缓存读取）')
    return this.view(job)
  }
  async submit(body) {
    if (this.closed) throw httpError(503, '图库正在重载')
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, '请求格式错误')
    if (body.tool !== 'wd14') throw httpError(400, '请选择 WD14 工具')
    const options = normalizeOptions(body.options)
    await this.ready; await this.store.ready
    if (this.historyError) throw httpError(503, '反推记录读取异常，已保留原文件')
    const source = this.resolveSource(body.id)
    const model = (await this.models()).find(model => model.id === body.model)
    if (!model) throw httpError(400, '本地模型不存在，请刷新工具列表')
    const key = digest(JSON.stringify([2, source.real, source.stat.size, source.stat.mtimeMs, model.signature, options]))
    if (this.pending.has(key)) return this.view(this.pending.get(key))
    if (this.pending.size >= 9) throw httpError(429, '反推队列已满，请等待现有任务完成')
    while (this.jobs.size >= 100) {
      const old = [...this.jobs.values()].find(job => !['queued', 'running'].includes(job.state))
      if (!old) break
      this.jobs.delete(old.id)
      if (old.imageId !== body.id && old.imageId.startsWith('upload:') && ![...this.jobs.values()].some(other => other.imageId === old.imageId)) await this.uploads.remove(old.imageId)
    }
    const job = { id: randomUUID(), imageId: body.id, name: source.name || path.basename(source.path), state: 'queued', createdAt: Date.now(), options, model, source, key }
    // Register before asynchronous cache I/O so simultaneous clicks coalesce.
    this.jobs.set(job.id, job)
    this.pending.set(key, job)
    try { await this.persistHistory() } catch (error) { this.jobs.delete(job.id); this.pending.delete(key); throw error }
    try {
      if (body.id.startsWith('upload:')) throw new Error('temporary source')
      const cached = JSON.parse(await fs.readFile(path.join(this.directory, `${key}.json`), 'utf8'))
      if (job.state !== 'cancelled' && typeof cached.text === 'string' && Array.isArray(cached.tags) && Array.isArray(cached.ratings)) {
        job.state = 'done'; job.cached = true; job.result = cached
      }
    } catch { /* no cache yet */ }
    if (this.closed || job.state === 'cancelled') { job.state = 'cancelled'; if (this.pending.get(key) === job) this.pending.delete(key) }
    else if (job.state === 'done') { this.pending.delete(key); await this.onResult?.(job); job.completedAt = Date.now(); await this.remember() }
    else { this.queue.push(job); this.pump() }
    return this.view(job)
  }
  pump() {
    if (this.closed || this.active || !this.queue.length) return
    const job = this.queue.shift()
    this.active = job
    job.state = 'running'
    this.remember()
    this.activeTask = this.execute(job).then(async result => {
      if (job.state !== 'cancelled') { job.result = result; await this.onResult?.(job); if (job.state !== 'cancelled') { if (this.pending.get(job.key) === job) this.pending.delete(job.key); job.state = 'done' } }
    }, error => {
      if (job.state !== 'cancelled') { job.error = error.message; job.state = 'error' }
    }).catch(error => { if (job.state !== 'cancelled') { job.state = 'error'; job.error = error.message } }).finally(async () => { job.completedAt = Date.now(); await this.remember(); if (this.pending.get(job.key) === job) this.pending.delete(job.key); this.active = null; this.pump() })
  }
  async execute(job) {
    // Recheck roots and file identity after queueing; never process a replaced link.
    const source = this.resolveSource(job.imageId)
    if (source.real !== job.source.real || source.stat.size !== job.source.stat.size || source.stat.mtimeMs !== job.source.stat.mtimeMs) throw new Error('图片已变化，请重新反推')
    const result = await this.runProcess([], { image: source.real, model: job.model.model, labels: job.model.labels, options: job.options }, this.timeout, job)
    if (job.state === 'cancelled') return
    if (typeof result.text !== 'string' || !Array.isArray(result.tags) || !Array.isArray(result.ratings)) throw new Error('反推工具返回格式错误')
    if (job.imageId.startsWith('upload:')) return result
    const target = path.join(this.directory, `${job.key}.json`), temp = `${target}.${job.id}.tmp`
    try {
      await fs.mkdir(this.directory, { recursive: true })
      await fs.writeFile(temp, JSON.stringify(result))
      await fs.rename(temp, target)
    } catch (error) { console.warn('[comfyui-gallery] caption cache:', error.message) }
    finally { await fs.rm(temp, { force: true }).catch(() => {}) }
    return result
  }
  runProcess(args, payload, timeout, job) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('图库正在重载'))
      const child = spawn(this.store.config.python, ['-X', 'utf8', script, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', OMP_NUM_THREADS: '2' } })
      this.children.add(child)
      if (job) job.child = child
      else this.probeChild = child
      let stdout = '', stderr = '', failure = ''
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
      const timer = setTimeout(() => { failure = '反推超时，请稍后重试'; child.kill() }, timeout)
      child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 8 * 1024 * 1024) { failure = '反推输出过大'; child.kill() } })
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000) })
      child.stdin.on('error', () => {})
      child.on('error', error => { clearTimeout(timer); this.children.delete(child); reject(new Error(`Python 启动失败：${error.message}`)) })
      child.on('close', code => {
        clearTimeout(timer)
        this.children.delete(child)
        let value
        try { value = JSON.parse(stdout) } catch { /* error below */ }
        if (failure || code !== 0 || !value || value.error) reject(new Error(failure || value?.error || stderr || `反推进程退出：${code}`))
        else resolve(value)
      })
      child.stdin.end(payload ? JSON.stringify(payload) : undefined)
    })
  }
  cancel(id) {
    const job = this.jobs.get(id)
    if (!job) throw httpError(404, '任务不存在')
    if (['queued', 'running'].includes(job.state)) {
      job.state = 'cancelled'
      job.child?.kill()
      this.queue = this.queue.filter(item => item !== job)
      this.pending.delete(job.key)
      job.completedAt = Date.now(); this.remember()
    }
    return this.view(job)
  }
  resolveSource(id) { return typeof id === 'string' && id.startsWith('upload:') ? this.uploads.resolve(id) : this.store.resolve(id) }
  async upload(data, name) {
    return this.uploads.add(data, async image => {
      try { return await this.runProcess(['--validate-image'], { image }, 15000) }
      catch (error) { throw httpError(400, '图片读取失败：' + error.message) }
    }, name)
  }
  async releaseUpload(id) {
    await this.ready
    if (typeof id !== 'string' || !id.startsWith('upload:')) throw httpError(400, '上传图片标识错误')
    if (![...this.jobs.values()].some(job => job.imageId === id)) await this.uploads.remove(id)
    return { ok: true }
  }
  async currentUpload(id) {
    await this.ready
    const selected = id || [...this.uploads.items].sort((a, b) => b[1].createdAt - a[1].createdAt)[0]?.[0]
    if (!selected) return null
    const upload = this.uploads.view(selected)
    const job = [...this.jobs.values()].filter(job => job.imageId === selected).sort((a, b) => b.createdAt - a.createdAt)[0]
    return { ...upload, job: job ? this.view(job) : undefined }
  }
  async removeUpload(id) {
    await this.ready
    if (typeof id !== 'string' || !id.startsWith('upload:')) throw httpError(400, '上传图片标识错误')
    for (const job of this.jobs.values()) if (job.imageId === id) { this.cancel(job.id); this.jobs.delete(job.id) }
    await this.persistHistory()
    await this.uploads.remove(id)
    return { ok: true }
  }
  async close() {
    if (this.closeTask) return this.closeTask
    this.closed = true
    this.closeTask = (async () => {
      await this.ready
      for (const child of this.children) child.kill()
      this.probeChild?.kill()
      for (const job of this.jobs.values()) this.cancel(job.id)
      await this.activeTask
      await this.remember()
      await this.uploads.close()
    })()
    return this.closeTask
  }
}
