import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { httpError } from './store.js'

export class Batches {
  constructor(store, interrogator, library) { this.store = store; this.interrogator = interrogator; this.library = library; this.jobs = new Map(); this.closed = false }
  view(job) { const { child, task, ...value } = job; return value }
  status(id) { const job = this.jobs.get(id); if (!job) throw httpError(404, '批量任务不存在'); return this.view(job) }
  async start(body) {
    if (this.closed) throw httpError(503, '图库正在重载')
    if ([...this.jobs.values()].some(j => j.state === 'running')) throw httpError(409, '已有批量反推任务，请先等待或取消')
    if (!Array.isArray(body?.ids) || !body.ids.length || body.ids.length > 200) throw httpError(400, '每批请选择 1–200 张图片')
    const ids = [...new Set(body.ids)]
    await this.store.ready
    ids.forEach(id => this.store.resolve(id))
    const tools = await this.interrogator.tools()
    if (!tools.tools[0].ready) throw httpError(400, tools.tools[0].reason)
    const model = body.model || tools.tools[0].models[0].id
    if (!tools.tools[0].models.some(m => m.id === model)) throw httpError(400, '模型不存在')
    const options = body.options || {}
    // Validate before accepting any jobs.
    const { normalizeOptions } = await import('./interrogate.js')
    normalizeOptions(options)
    if (this.closed) throw httpError(503, '图库正在重载')
    if ([...this.jobs.values()].some(j => j.state === 'running')) throw httpError(409, '已有批量反推任务，请先等待或取消')
    while (this.jobs.size >= 20) this.jobs.delete(this.jobs.keys().next().value)
    const job = { id: randomUUID(), state: 'running', total: ids.length, completed: 0, results: [], errors: [], createdAt: Date.now() }
    this.jobs.set(job.id, job)
    job.task = this.run(job, ids, model, options).catch(e => { if (job.state !== 'cancelled') { job.state = 'error'; job.error = e.message } })
    return this.view(job)
  }
  async run(job, ids, model, options) {
    for (const id of ids) {
      if (this.closed || job.state === 'cancelled') break
      try {
        const source = this.store.resolve(id), expectedSignature = this.store.signature(source.path, source.stat)
        let value
        for (;;) {
          try { value = await this.interrogator.submit({ id, tool: 'wd14', model, options }); break }
          catch (e) { if (e.status !== 429) throw e; if (this.closed || job.state === 'cancelled') return; await sleep(200) }
        }
        job.child = value.jobId
        while (['queued', 'running'].includes(value.state)) {
          if (this.closed || job.state === 'cancelled') { this.interrogator.cancel(value.jobId); return }
          await sleep(200); value = this.interrogator.status(value.jobId)
        }
        if (value.state !== 'done') throw new Error(value.error || '反推已取消')
        await this.library.update(id, { text: value.result.text, tags: value.result.tags.map(t => t.tag), expectedSignature }, true)
        job.results.push({ id, text: value.result.text, model: value.model, cached: value.cached })
      } catch (e) { job.errors.push({ id, error: e.message }) }
      job.completed++
    }
    if (job.state === 'running') job.state = this.closed ? 'cancelled' : 'done'
  }
  cancel(id) { const job = this.jobs.get(id); if (!job) throw httpError(404, '批量任务不存在'); if (job.state === 'running') { job.state = 'cancelled'; if (job.child) this.interrogator.cancel(job.child) }; return this.view(job) }
  async close() { this.closed = true; for (const job of this.jobs.values()) this.cancel(job.id); await Promise.allSettled([...this.jobs.values()].map(j => j.task)) }
}
