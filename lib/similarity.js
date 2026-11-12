import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import { encodeId, httpError } from './store.js'

export class Similarity {
  constructor(store) {
    this.store = store
    this.file = path.join(store.config.cacheDir, 'similarity.json')
    this.records = {}
    this.job = null
    this.closed = false
    this.ready = this.load()
  }
  async load() { try { const data = JSON.parse(await fs.readFile(this.file, 'utf8')); if (data.version === 1 && data.items && typeof data.items === 'object' && !Array.isArray(data.items)) this.records = data.items } catch (e) { if (e.code !== 'ENOENT') console.warn('[gallery] fingerprint cache:', e.message) } }
  async capability() {
    const comfy = this.store.config.comfyRoot || path.join(path.dirname(path.dirname(this.store.config.python)), 'ComfyUI')
    const model = this.store.config.similarityModel || path.join(comfy, 'models', 'clip_vision', 'CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors')
    const config = path.join(comfy, 'comfy', 'clip_vision_config_h.json')
    try {
      const stat = await fs.stat(model), configStat = await fs.stat(config)
      if (!stat.isFile() || !configStat.isFile()) throw new Error('模型文件格式错误')
      return { ready: true, model, config, modelKey: `${model}:${stat.size}:${stat.mtimeMs}:${configStat.size}:${configStat.mtimeMs}:clip-bf16-v3`, name: path.basename(model) }
    } catch { return { ready: false, reason: '尚未找到本地 CLIP ViT-H 视觉模型或配置；视觉指纹分组仍可使用' } }
  }
  view(params = {}) {
    if (!this.job) return { state: 'idle', total: 0, completed: 0, groups: [], errors: [] }
    const { child, groups, ...view } = this.job
    const offset = Math.max(0, Math.trunc(Number(params.offset) || 0)), limit = Math.min(50, Math.max(1, Math.trunc(Number(params.limit) || 20)))
    return { ...view, groupCount: groups.length, offset, groups: groups.slice(offset, offset + limit).map(g => ({ ...g, memberCount: g.members.length, members: g.members.slice(0, 200) })) }
  }
  async start(body) {
    await this.ready; await this.store.ready
    if (this.closed) throw httpError(503, '图库正在重载')
    if (this.job && ['running', 'grouping'].includes(this.job.state)) throw httpError(409, '已有相似图任务，请等待或取消')
    // A cancelled child may still be exiting and writing its partial cache.
    await this.task
    const mode = body?.mode || 'phash', level = body?.level || 'normal'
    if (!['phash', 'semantic'].includes(mode) || !['strict', 'normal', 'loose'].includes(level)) throw httpError(400, '分组方式或相似程度错误')
    const ids = body?.all === true ? [...this.store.entries.keys()].map(encodeId) : body?.ids
    if (!Array.isArray(ids) || !ids.length || (body.all !== true && ids.length > 200) || ids.some(id => typeof id !== 'string')) throw httpError(400, '请选择 1–200 张图片，或明确选择全图库')
    let capability = {}
    if (mode === 'semantic') { capability = await this.capability(); if (!capability.ready) throw httpError(400, capability.reason) }
    if (this.closed) throw httpError(503, '图库正在重载')
    if (this.job && ['running', 'grouping'].includes(this.job.state)) throw httpError(409, '已有相似图任务，请等待或取消')
    const job = { id: randomUUID(), state: 'running', mode, level, total: new Set(ids).size, completed: 0, groups: [], errors: [], message: '正在准备图片索引…' }
    this.job = job
    this.task = this.run(job, [...new Set(ids)], capability).catch(e => { if (job.state !== 'cancelled') { job.state = 'error'; job.error = e.message } })
    return this.view()
  }
  stamp(source) { return `${source.real}:${source.stat.size}:${source.stat.mtimeMs}` }
  async run(job, ids, capability) {
    const images = []
    for (const id of ids) {
      if (this.closed || job.state === 'cancelled') return
      try {
        const source = this.store.resolve(id), stamp = this.stamp(source), cached = this.records[id]
        const vector = typeof cached?.vector === 'string' ? Buffer.from(cached.vector, 'base64') : null
        const valid = cached?.stamp === stamp && /^[a-f0-9]{16}$/.test(cached.hash || '') && Number.isFinite(cached.ratio) && (job.mode !== 'semantic' || cached.modelKey === capability.modelKey && vector?.length === 1024 && vector.some(v => v !== 0))
        images.push({ id, path: source.real, stamp, cached: valid ? cached : undefined })
      } catch (e) { job.errors.push({ id, error: e.message }); job.completed++ }
      if (images.length % 32 === 0) await yieldTurn()
    }
    const byId = new Map(images.map(i => [i.id, i]))
    try { await new Promise((resolve, reject) => {
      if (this.closed || job.state === 'cancelled') return resolve()
      const script = fileURLToPath(new URL('../scripts/analyze.py', import.meta.url))
      const child = spawn(this.store.config.python, ['-X', 'utf8', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } })
      job.child = child
      let buffer = '', stderr = '', done = false, fatal = ''
      const timer = setTimeout(() => { fatal = '索引任务已达到时间上限；可缩小图片范围重试'; child.kill() }, 4 * 3600000)
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        buffer += chunk
        if (buffer.length > 64 * 1024 * 1024) { fatal = '索引输出过大'; child.kill(); return }
        let end
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
          try {
            const value = JSON.parse(line)
            if (job.state === 'cancelled') continue
            if (value.event === 'item') {
              const original = byId.get(value.record.id)
              if (original && value.record.stamp === original.stamp && this.stamp(this.store.resolve(original.id)) === original.stamp) this.records[original.id] = value.record
            } else if (value.event === 'progress') job.completed++
            else if (value.event === 'itemError') { if (job.errors.length < 100) job.errors.push({ id: value.id, error: value.error }); job.completed++ }
            else if (value.event === 'loading') job.message = value.message
            else if (value.event === 'grouping') { job.state = 'grouping'; job.message = `正在生成分组，剩余 ${value.remaining} 张…` }
            else if (value.event === 'done') { job.groups = value.groups; job.indexed = value.indexed; done = true }
            else if (value.event === 'fatal') fatal = value.error
          } catch { fatal = '索引工具返回格式错误' }
        }
      })
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000) })
      child.stdin.on('error', () => {})
      child.on('error', e => { clearTimeout(timer); reject(e) })
      child.on('close', code => {
        clearTimeout(timer)
        if (job.state === 'cancelled') resolve()
        else if (fatal || code !== 0 || !done) reject(new Error(fatal || stderr || '索引进程意外退出'))
        else resolve()
      })
      child.stdin.end(JSON.stringify({ images, mode: job.mode, level: job.level, clipModel: capability.model, clipConfig: capability.config, modelKey: capability.modelKey }))
    })
      if (job.state !== 'cancelled') {
        const valid = new Set()
        for (const image of images) {
          try {
            if (this.stamp(this.store.resolve(image.id)) !== image.stamp) throw new Error('图片在索引期间已变化，请重新索引')
            valid.add(image.id)
          } catch (e) { if (job.errors.length < 100) job.errors.push({ id: image.id, error: e.message }) }
          if (valid.size % 32 === 0) await yieldTurn()
          if (this.closed || job.state === 'cancelled') break
        }
        job.groups = job.groups.filter(g => valid.has(g.representative)).map(g => ({ ...g, members: g.members.filter(m => valid.has(m.id)) })).filter(g => g.members.length > 1)
        if (job.state !== 'cancelled') { job.state = 'done'; job.message = `分组完成：${job.groups.length} 组` }
      }
    } finally { await this.save() }
  }
  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const temp = `${this.file}.${randomUUID()}.tmp`
    try { await fs.writeFile(temp, JSON.stringify({ version: 1, items: this.records })); await fs.rename(temp, this.file) }
    finally { await fs.rm(temp, { force: true }).catch(() => {}) }
  }
  cancel() { if (this.job && ['running', 'grouping'].includes(this.job.state)) { this.job.state = 'cancelled'; this.job.message = '已取消；已完成的指纹会保留'; this.job.child?.kill() }; return this.view() }
  async close() { this.closed = true; this.cancel(); await this.task }
}
