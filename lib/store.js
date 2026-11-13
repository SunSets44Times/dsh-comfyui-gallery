import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { readPngInfo, safeJson } from './png.js'
import { describeMetadata, excerpt } from './extract.js'

export const EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
export const encodeId = filename => Buffer.from(filename, 'utf8').toString('base64url')
export const httpError = (status, message) => Object.assign(new Error(message), { status })
const within = (root, filename) => { const rel = path.relative(root, filename); return rel === '' || rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) }
const bounded = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Math.floor(Number(value)))) : fallback
const present = filename => { try { return fs.statSync(filename).isDirectory() } catch { return false } }

export function loadConfig(overrides = {}) {
  const cacheDir = path.resolve(overrides.cacheDir || path.join(os.homedir(), '.dsh-comfyui-gallery'))
  let saved = {}
  try { saved = JSON.parse(fs.readFileSync(path.join(cacheDir, 'config.json'), 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[comfyui-gallery] config.json:', error.message)
  }
  const config = { ...saved, ...overrides, cacheDir }
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  const autoRoots = [path.join('D:', 'Program Files', 'Comfy UI', 'ComfyUI', 'output'), path.join(workspace, 'out'), path.join(os.homedir(), 'Documents', 'deepseek-harness', 'ComfyUI', 'out')]
  const registry = Array.isArray(config.registryRoots) ? config.registryRoots.flatMap(p => typeof p === 'string' ? [path.join(p, 'output'), path.join(p, 'ComfyUI', 'output')] : []) : []
  config.roots = [...new Set((Array.isArray(config.roots) ? config.roots : [...autoRoots, ...registry]).filter(p => typeof p === 'string' && path.isAbsolute(p)).map(p => path.resolve(p)))].filter(present)
  config.thumbMax = bounded(config.thumbMax, 480, 64, 2048)
  config.pageSize = bounded(config.pageSize, 60, 1, 200)
  config.warmCount = bounded(config.warmCount, 300, 0, 10000)
  config.scanIntervalMs = bounded(config.scanIntervalMs, 30000, 1000, 3600000)
  config.python = config.python || [path.join('D:', 'Program Files', 'Comfy UI', 'python', 'python.exe'), path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')].find(p => fs.existsSync(p)) || 'python'
  return config
}

function otherDimensions(filename, extension) {
  let fd
  try {
    fd = fs.openSync(filename, 'r')
    const data = Buffer.alloc(256 * 1024), length = fs.readSync(fd, data, 0, data.length, 0)
    if (extension === '.webp' && length >= 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
      const type = data.toString('ascii', 12, 16)
      if (type === 'VP8X') return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 }
      if (type === 'VP8 ' && data[23] === 0x9d && data[24] === 1 && data[25] === 0x2a) return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff }
      if (type === 'VP8L' && data[20] === 0x2f) {
        const bits = data.readUInt32LE(21)
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
      }
    }
    if (data[0] === 0xff && data[1] === 0xd8) {
      let cursor = 2
      while (cursor + 9 < length) {
        if (data[cursor++] !== 0xff) break
        while (data[cursor] === 0xff) cursor++
        const marker = data[cursor++]
        if (marker === 0xda || marker === 0xd9) break
        if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue
        const size = data.readUInt16BE(cursor)
        if (size < 2) break
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return { height: data.readUInt16BE(cursor + 3), width: data.readUInt16BE(cursor + 5) }
        cursor += size
      }
    }
  } catch { /* non-image or incomplete file */ } finally { if (fd !== undefined) fs.closeSync(fd) }
  return {}
}

export class GalleryStore {
  constructor(overrides = {}) {
    this.config = loadConfig(overrides)
    this.entries = new Map()
    this.details = new Map()
    this.realRoots = this.config.roots.map(root => ({ root, real: fs.realpathSync(root) }))
    this.dirty = false
    this.closed = false
    this.scanPromise = null
    this.lastScan = 0
    this.ready = this.load()
  }
  async load() {
    try {
      const index = JSON.parse(await fsp.readFile(path.join(this.config.cacheDir, 'index.json'), 'utf8'))
      if (index.version === 1 && Array.isArray(index.items)) {
        for (const item of index.items) {
          if (index.metadataVersion !== 2) delete item.meta
          if (typeof item.path === 'string' && this.config.roots.some(root => within(root, item.path))) this.entries.set(item.path, item)
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') console.warn('[comfyui-gallery] index:', error.message) }
    if (!this.closed) this.refresh().catch(error => console.warn('[comfyui-gallery] scan:', error.message))
  }
  resolve(id) {
    if (typeof id !== 'string' || id.length > 16384 || !/^[\w-]+$/.test(id)) throw httpError(400, '图片 id 格式错误')
    const filename = Buffer.from(id, 'base64url').toString('utf8')
    if (encodeId(filename) !== id || filename.includes('\0') || !path.isAbsolute(filename)) throw httpError(400, '图片 id 格式错误')
    const normalized = path.resolve(filename)
    if (!EXTENSIONS.has(path.extname(normalized).toLowerCase())) throw httpError(403, '仅支持图片文件')
    const root = this.realRoots.find(r => within(r.root, normalized))
    if (!root) throw httpError(403, '图片位于图库目录之外')
    let real, stat
    try { real = fs.realpathSync(normalized); stat = fs.statSync(real) } catch { throw httpError(404, '图片已移动或删除') }
    if (!within(root.real, real)) throw httpError(403, '图片链接位于图库目录之外')
    if (!stat.isFile()) throw httpError(404, '图片不存在')
    return { path: normalized, real, stat, root: root.root, realRoot: root.real }
  }
  sidecar(file) {
    for (const candidate of [file.path.replace(/\.[^.]+$/, '.json'), `${file.path}.json`]) {
      try {
        const real = fs.realpathSync(candidate)
        if (!within(file.realRoot, real) || fs.statSync(real).size > 16 * 1024 * 1024) continue
        const value = safeJson(fs.readFileSync(real, 'utf8'))
        if (value && typeof value === 'object') return value
      } catch { /* optional companion file */ }
    }
    return {}
  }
  blobs(file) {
    const ext = path.extname(file.path).toLowerCase()
    const info = ext === '.png' ? readPngInfo(file.real) || {} : otherDimensions(file.real, ext)
    const companion = this.sidecar(file)
    let rawPrompt = info.text?.prompt, rawWorkflow = info.text?.workflow
    const toRaw = value => typeof value === 'string' ? value : value && typeof value === 'object' ? JSON.stringify(value) : undefined
    rawPrompt ??= toRaw(companion.prompt ?? companion.rawPrompt ?? companion.api_prompt)
    rawWorkflow ??= toRaw(companion.workflow ?? companion.rawWorkflow)
    return { info, companion, rawPrompt, rawWorkflow }
  }
  async detail(id) {
    await this.ready
    const file = this.resolve(id)
    const cached = this.details.get(file.path)
    const signature = this.signature(file.path, file.stat)
    if (cached?.signature === signature) { this.details.delete(file.path); this.details.set(file.path, cached); return cached.value }
    const { info, rawPrompt, rawWorkflow, companion } = this.blobs(file)
    const description = describeMetadata(safeJson(rawPrompt), safeJson(rawWorkflow), info, path.basename(file.path))
    // Workbench sidecars may carry flat parameters instead of an API graph.
    if (!description.hasMetadata && (typeof companion.positive === 'string' || typeof companion.negative === 'string')) {
      description.positive = companion.positive || ''
      description.negative = companion.negative || ''
      description.hasMetadata = true
      if (companion.sampling && typeof companion.sampling === 'object') description.sampling = companion.sampling
    }
    const value = { id, path: file.path, name: path.basename(file.path), size: file.stat.size, mtime: file.stat.mtimeMs, width: info.width, height: info.height, ...description }
    this.details.set(file.path, { signature, value })
    if (this.details.size > 80) this.details.delete(this.details.keys().next().value)
    const entry = this.entry(file.path, file.stat, file.root, signature)
    entry.meta = { positive: value.positive, negative: value.negative, hasMetadata: value.hasMetadata, width: value.width, height: value.height,
      catalogVersion: 1, models: [...new Set(Object.values(value.models || {}).flat())], loras: [...new Set((value.loras || []).map(l => l.name))] }
    this.entries.set(file.path, entry)
    this.markDirty()
    return value
  }
  async raw(id, kind) {
    if (!['prompt', 'workflow'].includes(kind)) throw httpError(400, 'kind 应为 prompt 或 workflow')
    await this.ready
    const blobs = this.blobs(this.resolve(id))
    const raw = kind === 'prompt' ? blobs.rawPrompt : blobs.rawWorkflow
    if (raw === undefined) throw httpError(404, '这张图片未保存该原始数据')
    return raw
  }
  async remove(id) {
    await this.ready
    const file = this.resolve(id)
    await fsp.rm(file.real, { force: true })
    const removed = [path.basename(file.real)]
    // ComfyUI writes the workflow beside the image; drop that companion with it,
    // unless another image with the same stem still needs it.
    const stem = file.path.replace(/\.[^.]+$/, '')
    const sharesStem = [...EXTENSIONS].some(ext => {
      try { return fs.statSync(`${stem}${ext}`).isFile() } catch { return false }
    })
    if (!sharesStem) {
      for (const candidate of [`${stem}.json`, `${file.path}.json`]) {
        try {
          const real = fs.realpathSync(candidate), stat = fs.statSync(real)
          if (!within(file.realRoot, real) || !stat.isFile() || stat.size > 16 * 1024 * 1024) continue
          await fsp.rm(real, { force: true })
          removed.push(path.basename(real))
        } catch { /* optional companion file */ }
      }
    }
    this.entries.delete(file.path)
    this.details.delete(file.path)
    this.markDirty()
    return { id, path: file.path, name: path.basename(file.path), removed }
  }
  signature(filename, stat) {
    let companion = ''
    for (const p of [filename.replace(/\.[^.]+$/, '.json'), `${filename}.json`]) {
      try { const s = fs.statSync(p); companion += `:${s.size}:${s.mtimeMs}` } catch { companion += ':' }
    }
    return `${stat.size}:${stat.mtimeMs}${companion}`
  }
  entry(filename, stat, root, signature) {
    const previous = this.entries.get(filename)
    return { path: filename, name: path.basename(filename), dir: path.basename(root), sub: path.dirname(path.relative(root, filename)) === '.' ? '' : path.dirname(path.relative(root, filename)), root, size: stat.size, mtime: stat.mtimeMs, signature, meta: previous?.signature === signature ? previous.meta : undefined }
  }
  refresh() {
    if (this.scanPromise) return this.scanPromise
    if (this.closed) return Promise.resolve({ total: this.entries.size })
    this.scanPromise = this.scan().finally(() => { this.scanPromise = null })
    return this.scanPromise
  }
  async scan() {
    const found = new Map()
    const walk = async (directory, root, depth) => {
      if (this.closed) return
      let children
      try { children = await fsp.readdir(directory, { withFileTypes: true }) } catch (error) {
        if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error
        return
      }
      const files = children.filter(c => c.isFile() && EXTENSIONS.has(path.extname(c.name).toLowerCase()))
      for (let offset = 0; offset < files.length; offset += 32) {
        await Promise.all(files.slice(offset, offset + 32).map(async child => {
          const filename = path.join(directory, child.name)
          if (found.has(filename)) return
          try { const stat = await fsp.stat(filename); found.set(filename, this.entry(filename, stat, root, this.signature(filename, stat))) } catch { /* file changed during scan */ }
        }))
        await nextTurn()
      }
      if (depth < 4) for (const child of children) if (child.isDirectory() && !child.isSymbolicLink() && !child.name.startsWith('.gallery-import-')) await walk(path.join(directory, child.name), root, depth + 1)
    }
    for (const root of this.config.roots) await walk(root, root, 0)
    if (this.closed) return { total: this.entries.size }
    this.entries = found
    this.lastScan = Date.now()
    this.markDirty()
    this.warm().catch(error => console.warn('[comfyui-gallery] warm:', error.message))
    return { total: found.size }
  }
  async warm() {
    if (this.warming || this.closed) return
    this.warming = true
    try {
      const recent = [...this.entries.values()].sort((a, b) => b.mtime - a.mtime).slice(0, this.config.warmCount)
      for (let i = 0; i < recent.length && !this.closed; i++) {
        if (!recent[i].meta?.catalogVersion) try { await this.detail(encodeId(recent[i].path)) } catch { /* removed/unreadable file */ }
        // Yield every image, so a large workflow never blocks a whole batch.
        await nextTurn()
      }
    } finally { this.warming = false }
  }
  async list(params = {}) {
    await this.ready
    await this.library?.ready
    if (!this.entries.size && this.scanPromise) await Promise.race([this.scanPromise, new Promise(resolve => setTimeout(resolve, 150))])
    if (Date.now() - this.lastScan > this.config.scanIntervalMs) this.refresh().catch(error => console.warn('[comfyui-gallery] scan:', error.message))
    const offset = bounded(params.offset, 0, 0, Number.MAX_SAFE_INTEGER), limit = bounded(params.limit, this.config.pageSize, 1, 200)
    const q = String(params.q || '').trim().toLocaleLowerCase(), dir = String(params.dir || '')
    const all = [...this.entries.values()]
    const items = all.filter(item => (!dir || item.sub === dir || item.sub.startsWith(`${dir}${path.sep}`) || item.root === dir) && (!this.library || this.library.matches(item, params)) && (!q || `${item.name}\n${item.meta?.positive || ''}\n${item.meta?.negative || ''}\n${this.library?.search(item) || ''}`.toLocaleLowerCase().includes(q)))
    items.sort((a, b) => (params.sort === 'asc' ? a.mtime - b.mtime : b.mtime - a.mtime) || a.path.localeCompare(b.path))
    return { total: items.length, offset, limit, roots: this.config.roots, scanning: !!this.scanPromise, warming: !!this.warming, directories: [...new Set(all.map(i => i.sub).filter(Boolean))].sort(), items: items.slice(offset, offset + limit).map(item => ({ id: encodeId(item.path), name: item.name, dir: item.dir, sub: item.sub, size: item.size, mtime: item.mtime, hasMeta: !!item.meta?.hasMetadata, excerpt: excerpt(item.meta?.positive || this.library?.generated(item)?.text), w: item.meta?.width, h: item.meta?.height,
      ...(this.library ? { favorite: !!this.library.get(encodeId(item.path)).favorite, rating: this.library.get(encodeId(item.path)).rating || 0, tags: this.library.get(encodeId(item.path)).tags || [] } : {}) })) }
  }
  markDirty() {
    this.dirty = true
    if (!this.writeTimer && !this.closed) { this.writeTimer = setTimeout(() => { this.writeTimer = null; this.flush().catch(e => console.warn('[comfyui-gallery] save:', e.message)) }, 5000); this.writeTimer.unref?.() }
  }
  async flush() {
    if (this.writePromise) { await this.writePromise; if (this.dirty) return this.flush(); return }
    if (!this.dirty) return
    this.dirty = false
    const data = JSON.stringify({ version: 1, metadataVersion: 2, items: [...this.entries.values()] })
    this.writePromise = (async () => {
      await fsp.mkdir(this.config.cacheDir, { recursive: true })
      const target = path.join(this.config.cacheDir, 'index.json'), temp = `${target}.${randomUUID()}.tmp`
      try {
        await fsp.writeFile(temp, data)
        await fsp.rename(temp, target)
      } finally { await fsp.rm(temp, { force: true }).catch(() => {}) }
    })().catch(error => { this.dirty = true; throw error }).finally(() => { this.writePromise = null })
    return this.writePromise
  }
  async close() {
    this.closed = true
    clearTimeout(this.writeTimer)
    await this.scanPromise
    await this.flush()
  }
}
