import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { httpError } from './store.js'

export const UPLOAD_LIMIT = 20 * 1024 * 1024
const MEDIA = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }

export function imageType(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg'
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) return 'image/gif'
  throw httpError(415, '请选择 PNG、JPEG、WebP 或 GIF 图片')
}

// Uploads have opaque runtime IDs, separate from gallery paths and annotations.
export class Uploads {
  constructor(cacheDir, persistent = false) {
    this.root = path.join(cacheDir, 'uploads')
    this.persistent = persistent
    this.directory = path.join(this.root, persistent ? 'retained' : randomUUID())
    this.serial = Promise.resolve()
    this.items = new Map()
    this.bytes = 0
    this.reservations = 0
    this.reservedBytes = 0
    this.closed = false
    this.ready = this.initialize()
  }
  async initialize() {
    await fsp.mkdir(this.directory, { recursive: true })
    if (this.persistent) {
      try {
        const saved = JSON.parse(await fsp.readFile(path.join(this.directory, 'uploads.json'), 'utf8'))
        if (saved.version !== 1 || !Array.isArray(saved.items)) throw new Error('上传记录格式错误')
        for (const value of saved.items) {
          if (!/^upload:[a-f0-9-]{36}$/.test(value.id) || !MEDIA[value.mediaType]) continue
          const filename = path.join(this.directory, value.id.slice(7) + MEDIA[value.mediaType])
          const stat = await fsp.lstat(filename).catch(() => null)
          if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== value.size || stat.mtimeMs !== value.mtimeMs) continue
          if (this.items.size >= 20 || this.bytes + stat.size > 100 * 1024 * 1024) continue
          this.items.set(value.id, { real: filename, path: filename, stat, mediaType: value.mediaType, width: value.width, height: value.height, name: value.name || '上传图片', createdAt: value.createdAt || 0 })
          this.bytes += stat.size
        }
      } catch (error) { if (error.code !== 'ENOENT') { this.loadError = error; console.warn('[gallery] uploads:', error.message) } }
    }
    // Recover disk space after a previous process exited without disposal.
    for (const name of await fsp.readdir(this.root)) {
      if (!/^[a-f0-9-]{36}$/.test(name) || name === path.basename(this.directory)) continue
      const target = path.join(this.root, name), stat = await fsp.lstat(target).catch(() => null)
      if (stat?.isDirectory() && !stat.isSymbolicLink() && Date.now() - stat.mtimeMs > 86400000) await fsp.rm(target, { recursive: true, force: true }).catch(() => {})
    }
  }
  persist() {
    if (!this.persistent) return Promise.resolve()
    const task = this.serial.then(async () => {
      if (this.loadError) throw httpError(503, '上传记录读取异常，已保留原文件')
      const target = path.join(this.directory, 'uploads.json'), temp = target + '.' + randomUUID() + '.tmp'
      const items = [...this.items].map(([id, item]) => ({ id, mediaType: item.mediaType, size: item.stat.size, mtimeMs: item.stat.mtimeMs, width: item.width, height: item.height, name: item.name, createdAt: item.createdAt }))
      try { await fsp.writeFile(temp, JSON.stringify({ version: 1, items })); await fsp.rename(temp, target) }
      finally { await fsp.rm(temp, { force: true }).catch(() => {}) }
    })
    this.serial = task.catch(() => {})
    return task
  }
  view(id) {
    const item = this.resolve(id)
    return { id, mediaType: item.mediaType, size: item.stat.size, width: item.width, height: item.height, name: item.name, createdAt: item.createdAt }
  }
  async add(data, validate, name = '上传图片') {
    await this.ready
    if (this.closed) throw httpError(503, '图库正在重载')
    if (this.loadError) throw httpError(503, '上传记录读取异常，已保留原文件')
    if (typeof name !== 'string' || name.length > 512) throw httpError(400, '图片名称过长')
    name = path.win32.basename(name).replace(/[\u0000-\u001f]/g, '') || '上传图片'
    if (!data.length || data.length > UPLOAD_LIMIT) throw httpError(413, '图片应在 20 MB 以内且内容非空')
    const mediaType = imageType(data)
    if (this.reservations >= 2) throw httpError(429, '正在检查其他上传图片，请稍后重试')
    if (this.items.size + this.reservations >= 20 || this.bytes + this.reservedBytes + data.length > 100 * 1024 * 1024) throw httpError(429, '临时图片已满，请移除已有图片后重试')
    this.reservations++; this.reservedBytes += data.length
    const id = 'upload:' + randomUUID(), filename = path.join(this.directory, id.slice(7) + MEDIA[mediaType])
    try {
      await this.ready
      await fsp.writeFile(filename, data, { flag: 'wx' })
      const size = await validate(filename)
      if (this.closed) throw httpError(503, '图库正在重载')
      if (!size?.width || !size?.height || size.width * size.height > 40000000) throw httpError(400, '图片尺寸应在 4000 万像素以内')
      const stat = await fsp.stat(filename)
      this.items.set(id, { real: filename, path: filename, stat, mediaType, width: size.width, height: size.height, name, createdAt: Date.now() })
      this.bytes += stat.size
      await this.persist()
      return this.view(id)
    } catch (error) { const item = this.items.get(id); if (item) { this.bytes -= item.stat.size; this.items.delete(id) }; await fsp.rm(filename, { force: true }).catch(() => {}); throw error }
    finally { this.reservations--; this.reservedBytes -= data.length }
  }
  resolve(id) {
    const item = this.items.get(id)
    if (!item || this.closed) throw httpError(404, '上传图片已过期，请重新上传')
    const stat = fs.lstatSync(item.real)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.stat.size || stat.mtimeMs !== item.stat.mtimeMs) throw httpError(409, '上传图片已变化，请重新上传')
    return { ...item, stat }
  }
  async remove(id) {
    const item = this.items.get(id)
    if (!item) return
    this.items.delete(id); this.bytes -= item.stat.size
    try { await this.persist() }
    catch (error) { this.items.set(id, item); this.bytes += item.stat.size; throw error }
    await fsp.rm(item.real, { force: true, maxRetries: 5, retryDelay: 200 })
  }
  async close() {
    this.closed = true
    await this.ready.catch(() => {})
    if (this.persistent) { await this.persist(); return }
    this.items.clear(); this.bytes = 0
    await fsp.rm(this.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
  }
}
