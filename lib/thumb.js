import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { httpError } from './store.js'

export class ThumbnailCache {
  constructor(store) {
    this.store = store
    this.directory = path.join(store.config.cacheDir, 'thumbs')
    this.script = fileURLToPath(new URL('../scripts/thumb.py', import.meta.url))
    this.pending = new Map()
    this.queue = []
    this.running = new Set()
    this.closed = false
  }
  async get(id) {
    if (this.closed) throw httpError(503, '图库正在重载')
    const source = this.store.resolve(id)
    const key = createHash('sha1').update(`${source.path}:${source.stat.size}:${source.stat.mtimeMs}:${this.store.config.thumbMax}`).digest('hex')
    const target = path.join(this.directory, `${key}.webp`)
    try { await fs.access(target); return target } catch { /* generate below */ }
    if (this.pending.has(key)) return this.pending.get(key)
    if (this.queue.length >= 256) throw httpError(503, '缩略图队列繁忙，请稍后重试')
    const job = new Promise((resolve, reject) => { this.queue.push({ source: source.real, target, resolve, reject }); this.pump() }).finally(() => this.pending.delete(key))
    this.pending.set(key, job)
    return job
  }
  pump() {
    while (!this.closed && this.running.size < 4 && this.queue.length) {
      const job = this.queue.shift()
      this.running.add(job)
      this.generate(job).then(job.resolve, job.reject).finally(() => { this.running.delete(job); this.pump() })
    }
  }
  async generate(job) {
    await fs.mkdir(this.directory, { recursive: true })
    if (this.closed) throw httpError(503, '图库正在重载')
    const temp = `${job.target}.${randomUUID()}.tmp`
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(this.store.config.python, [this.script, job.source, temp, String(this.store.config.thumbMax)], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
        job.child = child
        let stderr = '', timedOut = false
        child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-2000) })
        const timer = setTimeout(() => { timedOut = true; child.kill() }, 30000)
        child.on('error', error => { clearTimeout(timer); reject(error) })
        child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(timedOut ? '缩略图生成超时' : `Pillow: ${stderr || code}`)) })
      })
      await fs.rename(temp, job.target)
      return job.target
    } finally { await fs.rm(temp, { force: true }).catch(() => {}) }
  }
  async discard(source) {
    try {
      const key = createHash('sha1').update(`${source.path}:${source.stat.size}:${source.stat.mtimeMs}:${this.store.config.thumbMax}`).digest('hex')
      await fs.rm(path.join(this.directory, `${key}.webp`), { force: true })
    } catch { /* no cached thumbnail */ }
  }
  async count() { try { return (await fs.readdir(this.directory)).filter(n => n.endsWith('.webp')).length } catch { return 0 } }
  close() {
    this.closed = true
    for (const job of this.queue.splice(0)) job.reject(httpError(503, '图库正在重载'))
    for (const job of this.running) job.child?.kill()
  }
}
