import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import { encodeId, httpError } from './store.js'

export class Library {
  constructor(store) {
    this.store = store
    this.file = path.join(store.config.cacheDir, 'library.json')
    this.data = {}
    this.serial = Promise.resolve()
    this.closed = false
    this.index = null
    this.ready = this.load()
  }
  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (saved.version !== 1 || !saved.items || typeof saved.items !== 'object' || Array.isArray(saved.items)) throw new Error('收藏数据格式错误')
      this.data = saved.items
    } catch (e) { if (e.code !== 'ENOENT') { this.loadError = e; console.warn('[gallery] library:', e.message) } }
  }
  get(id) { return this.data[id] || { favorite: false, rating: 0, tags: [], note: '' } }
  update(id, patch, generated = false) {
    const task = this.serial.then(async () => {
      await this.ready
      if (this.loadError) throw httpError(503, '收藏文件读取异常，已保留原文件，请检查 library.json')
      const source = this.store.resolve(id)
      const value = { ...this.get(id) }
      if (generated) {
        const signature = this.store.signature(source.path, source.stat)
        if (patch.expectedSignature && patch.expectedSignature !== signature) throw httpError(409, '图片已变化，请重新反推')
        const { expectedSignature, ...caption } = patch
        value.generated = { ...caption, signature }
      }
      else {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw httpError(400, '标记格式错误')
        if ('favorite' in patch) { if (typeof patch.favorite !== 'boolean') throw httpError(400, '收藏值格式错误'); value.favorite = patch.favorite }
        if ('rating' in patch) { if (!Number.isInteger(patch.rating) || patch.rating < 0 || patch.rating > 5) throw httpError(400, '评分应为 0–5'); value.rating = patch.rating }
        if ('tags' in patch) {
          if (!Array.isArray(patch.tags) || patch.tags.length > 30 || patch.tags.some(t => typeof t !== 'string' || t.length > 80)) throw httpError(400, '最多 30 个标签，每个最多 80 字')
          value.tags = [...new Set(patch.tags.map(t => t.trim()).filter(Boolean))]
        }
        if ('note' in patch) { if (typeof patch.note !== 'string' || patch.note.length > 4000) throw httpError(400, '备注最多 4000 字'); value.note = patch.note }
      }
      value.updatedAt = Date.now()
      const next = { ...this.data, [id]: value }, temp = `${this.file}.${randomUUID()}.tmp`
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      try { await fs.writeFile(temp, JSON.stringify({ version: 1, items: next })); await fs.rename(temp, this.file); this.data = next }
      finally { await fs.rm(temp, { force: true }).catch(() => {}) }
      return value
    })
    this.serial = task.catch(() => {})
    return task
  }
  generated(item) {
    const value = this.get(encodeId(item.path)).generated
    return value?.signature === item.signature ? value : null
  }
  matches(item, params) {
    const mark = this.get(encodeId(item.path))
    if (params.favorite === '1' && !mark.favorite) return false
    if (params.rating && (mark.rating || 0) < Number(params.rating)) return false
    if (params.tag && !(mark.tags || []).includes(params.tag)) return false
    if (params.model && !(item.meta?.models || []).includes(params.model)) return false
    if (params.lora && !(item.meta?.loras || []).includes(params.lora)) return false
    return true
  }
  search(item) {
    const mark = this.get(encodeId(item.path)), generated = this.generated(item)
    return `${(mark.tags || []).join(' ')}\n${mark.note || ''}\n${generated?.text || ''}\n${(item.meta?.models || []).join(' ')}\n${(item.meta?.loras || []).join(' ')}`
  }
  async facets() {
    await this.ready; await this.store.ready
    const models = new Set(), loras = new Set(), tags = new Set()
    let indexed = 0
    for (const item of this.store.entries.values()) {
      if (item.meta?.catalogVersion) indexed++
      for (const name of item.meta?.models || []) models.add(name)
      for (const name of item.meta?.loras || []) loras.add(name)
      for (const tag of this.get(encodeId(item.path)).tags || []) tags.add(tag)
    }
    return { models: [...models].sort(), loras: [...loras].sort(), tags: [...tags].sort(), indexed, total: this.store.entries.size, index: this.index }
  }
  async captions(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 200) throw httpError(400, '请选择 1–200 张图片导出')
    await this.ready; await this.store.ready
    const files = [], skipped = []
    for (const id of [...new Set(ids)]) {
      const source = this.store.resolve(id), item = this.store.entries.get(source.path)
      const generated = item && this.generated(item)
      if (!generated) { skipped.push(id); continue }
      // Keep a separate folder per image, including when basenames collide across roots.
      files.push({ id, folder: `image-${files.length + 1}`, name: `${path.parse(source.path).name}.txt`, text: generated.text })
    }
    return { files, skipped }
  }
  async startIndex() {
    await this.store.ready
    if (this.index?.state === 'running') return this.index
    this.index = { state: 'running', total: this.store.entries.size, completed: 0, errors: 0 }
    const job = this.index
    this.indexTask = (async () => {
      for (const item of [...this.store.entries.values()]) {
        if (this.closed || job.state === 'cancelled') break
        try { if (!item.meta?.catalogVersion) await this.store.detail(encodeId(item.path)) } catch { job.errors++ }
        job.completed++; await yieldTurn()
      }
      if (job.state === 'running') job.state = this.closed ? 'cancelled' : 'done'
      await this.store.flush()
    })().catch(e => { job.state = 'error'; job.error = e.message })
    return job
  }
  cancelIndex() { if (this.index?.state === 'running') this.index.state = 'cancelled'; return this.index }
  async close() { this.closed = true; this.cancelIndex(); await this.indexTask; await this.serial }
}
