import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { setImmediate as yieldTurn, setTimeout as delay } from 'node:timers/promises'
import { encodeId, httpError } from './store.js'
import { ThumbnailCache } from './thumb.js'
import { imageType } from './uploads.js'
import { downloadLoraResource } from './lora-network.js'

const MODELS = new Set(['.safetensors', '.ckpt', '.pt', '.bin'])
const IMAGES = ['.webp', '.png', '.jpg', '.jpeg', '.gif']
const within = (root, file) => { const rel = path.relative(root, file); return rel === '' || rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel) }
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const str = (value, max = 8000) => typeof value === 'string' ? value.slice(0, max) : ''
const strings = value => [...new Set((Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\n]/) : []).filter(v => typeof v === 'string').map(v => v.trim().slice(0, 200)).filter(Boolean))].slice(0, 100)
const tagKey = value => value.trim().toLocaleLowerCase()
const selectedTags = value => {
  if (!value) return []
  let parsed = value
  if (typeof value === 'string') { try { parsed = JSON.parse(value) } catch { parsed = [value] } }
  if (!Array.isArray(parsed) || parsed.length > 30 || parsed.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 200)) throw httpError(400, '来源标签筛选格式错误')
  return [...new Set(parsed.map(tagKey))]
}
const plain = value => str(value, 40000).replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').slice(0, 8000)
const json = value => { try { return object(typeof value === 'string' ? JSON.parse(value) : value) } catch { return {} } }

async function atomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temp = file + '.' + randomUUID() + '.tmp'
  try { await fsp.writeFile(temp, JSON.stringify(value)); await fsp.rename(temp, file) }
  finally { await fsp.rm(temp, { force: true }).catch(() => {}) }
}

export async function safetensorsMetadata(filename) {
  if (path.extname(filename).toLowerCase() !== '.safetensors') return { metadata: {}, tensorCount: 0 }
  const fd = await fsp.open(filename, 'r')
  try {
    const prefix = Buffer.alloc(8), first = await fd.read(prefix, 0, 8, 0)
    if (first.bytesRead !== 8) throw new Error('Safetensors 文件头不完整')
    const length = prefix.readBigUInt64LE(), stat = await fd.stat()
    if (length < 2n || length > 16n * 1024n * 1024n || length + 8n > BigInt(stat.size)) throw new Error('Safetensors 文件头大小异常')
    const buffer = Buffer.alloc(Number(length)), read = await fd.read(buffer, 0, buffer.length, 8)
    if (read.bytesRead !== buffer.length) throw new Error('Safetensors 文件头不完整')
    const header = object(JSON.parse(buffer.toString('utf8')))
    return { metadata: object(header.__metadata__), tensorCount: Object.keys(header).filter(k => k !== '__metadata__').length }
  } finally { await fd.close() }
}

export class Loras {
  constructor(store) {
    this.config = store.config
    this.directory = path.join(this.config.cacheDir, 'loras')
    this.annotationFile = path.join(this.directory, 'library.json')
    this.cacheFile = path.join(this.directory, 'index.json')
    this.batchFile = path.join(this.directory, 'fetch-history.json')
    this.batchSerial = Promise.resolve(); this.cacheSerial = Promise.resolve(); this.batch = null
    this.entries = new Map(); this.cache = {}; this.marks = {}; this.serial = Promise.resolve(); this.closed = false
    this.roots = []; this.jobs = new Map(); this.scan = null; this.lastScan = 0; this.download = downloadLoraResource
    this.thumbs = new ThumbnailCache({ config: this.config, resolve: id => this.preview(id) })
    this.ready = this.initialize()
  }
  async initialize() {
    const comfy = this.config.comfyRoot || path.join(path.dirname(path.dirname(this.config.python)), 'ComfyUI')
    const manager = this.config.loraManagerRoot || path.join(path.dirname(comfy), 'SD-LoRA-Manager-Portable')
    let candidates = this.config.loraRoots
    if (!Array.isArray(candidates)) {
      candidates = [path.join(comfy, 'models', 'loras')]
      try {
        const settings = JSON.parse(await fsp.readFile(path.join(manager, 'config', 'settings.json'), 'utf8'))
        candidates.push(...(Array.isArray(settings.lora_paths) ? settings.lora_paths.filter(p => !(settings.lora_paths_disabled || []).includes(p)) : []))
      } catch { /* manager is optional; never use its credentials or modify its files */ }
    }
    for (const root of [...new Set(candidates.filter(p => typeof p === 'string' && path.isAbsolute(p)).map(p => path.resolve(p)))].sort((a, b) => a.length - b.length)) {
      if (this.roots.some(r => within(r.path, root))) continue
      try { const stat = await fsp.stat(root); if (stat.isDirectory()) this.roots.push({ path: root, real: await fsp.realpath(root) }) } catch { /* missing configured root */ }
    }
    try {
      const saved = JSON.parse(await fsp.readFile(this.annotationFile, 'utf8'))
      if (saved.version !== 1 || !saved.items || typeof saved.items !== 'object' || Array.isArray(saved.items)) throw new Error('LoRA 收藏格式错误')
      this.marks = saved.items
    } catch (e) { if (e.code !== 'ENOENT') this.loadError = e.message }
    try { const saved = JSON.parse(await fsp.readFile(this.cacheFile, 'utf8')); if (saved.version === 1) this.cache = object(saved.items) } catch { /* rebuildable index */ }
    try {
      const saved = JSON.parse(await fsp.readFile(this.batchFile, 'utf8'))
      if (saved.version === 1 && saved.job && typeof saved.job === 'object') {
        this.batch = saved.job
        if (['running', 'cancelling'].includes(this.batch.state)) { this.batch.state = 'interrupted'; this.batch.current = null; this.batch.completedAt = Date.now() }
      }
    } catch { /* optional last batch summary */ }
    if (!this.closed) this.scan = this.scanFiles()
  }
  key(source) { return createHash('sha256').update(`${source.path}:${source.stat.size}:${source.stat.mtimeMs}`).digest('hex') }
  resolve(id) {
    if (typeof id !== 'string' || !/^[\w-]{1,16384}$/.test(id)) throw httpError(400, 'LoRA 标识格式错误')
    const file = Buffer.from(id, 'base64url').toString('utf8'), normalized = path.resolve(file)
    if (encodeId(file) !== id || !path.isAbsolute(file) || file.includes('\0') || normalized !== file || !MODELS.has(path.extname(file).toLowerCase())) throw httpError(400, 'LoRA 标识格式错误')
    const root = this.roots.find(r => within(r.path, file))
    if (!root) throw httpError(403, 'LoRA 位于配置目录之外')
    let stat, real
    try { stat = fs.lstatSync(file); real = fs.realpathSync(file) } catch { throw httpError(404, 'LoRA 已移动或删除') }
    if (!stat.isFile() || stat.isSymbolicLink() || !within(root.real, real)) throw httpError(403, 'LoRA 路径或链接不受支持')
    return { id, path: file, real, stat, root }
  }
  safeCompanion(source, filename, max = 16 * 1024 * 1024) {
    try {
      const stat = fs.lstatSync(filename), real = fs.realpathSync(filename)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max || !within(source.root.real, real)) return null
      return { path: filename, real, stat }
    } catch { return null }
  }
  sidecars(source) {
    const stem = source.path.slice(0, -path.extname(source.path).length)
    return [stem + '.metadata.json', stem + '.civitai.info', stem + '.json', source.path + '.json'].map(file => this.safeCompanion(source, file)).filter(Boolean)
  }
  signature(source) { return 'tags-v2:' + this.key(source) + this.sidecars(source).map(s => `:${s.path}:${s.stat.size}:${s.stat.mtimeMs}`).join('') }
  localPreview(source, metadata = {}) {
    const stem = source.path.slice(0, -path.extname(source.path).length)
    const candidates = IMAGES.flatMap(ext => [stem + '.preview' + ext, stem + ext, source.path + '.preview' + ext])
    if (typeof metadata.preview_url === 'string' && path.isAbsolute(metadata.preview_url)) candidates.push(metadata.preview_url)
    for (const file of candidates) {
      if (!IMAGES.includes(path.extname(file).toLowerCase())) continue
      const safe = this.safeCompanion(source, file, 20 * 1024 * 1024)
      if (safe) return safe
    }
  }
  remote(source) {
    const filename = path.join(this.directory, this.key(source) + '.json')
    try { const stat = fs.lstatSync(filename); if (!stat.isSymbolicLink() && stat.size < 8 * 1024 * 1024) return json(fs.readFileSync(filename, 'utf8')) } catch { /* optional download */ }
    return {}
  }
  async describe(source, raw = false) {
    const signature = this.signature(source), prior = this.cache[source.id]
    if (!raw && prior?.signature === signature) return prior.value
    let header = { metadata: {}, tensorCount: 0 }, metadataError = ''
    try { header = await safetensorsMetadata(source.real) } catch (e) { metadataError = e.message }
    const companions = []
    for (const file of this.sidecars(source)) {
      try { companions.push(json(await fsp.readFile(file.real, 'utf8'))) } catch { metadataError ||= '同名元数据 JSON 读取失败' }
    }
    const managed = companions.find(c => c.civitai || c.base_model || c.model_name) || {}, remote = this.remote(source)
    const localVersion = Object.keys(object(managed.civitai)).length ? managed.civitai : companions.find(c => c.baseModel || c.trainedWords || c.modelId) || {}
    const version = { ...localVersion, ...remote, model: { ...object(localVersion.model), ...object(remote.model) } }
    if (!Array.isArray(version.images) || !version.images.length) version.images = remote.images
    const model = object(version.model), metadata = header.metadata
    const frequency = json(metadata.ss_tag_frequency), counts = new Map()
    for (const group of Object.values(frequency)) for (const [tag, count] of Object.entries(object(group))) if (Number.isFinite(Number(count))) counts.set(tag, (counts.get(tag) || 0) + Number(count))
    const trainingTags = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 100).map(([tag, count]) => ({ tag, count }))
    const relative = path.relative(source.root.path, source.path).split(path.sep).join('/'), folder = path.posix.dirname(relative)
    const base = str(remote.baseModel || managed.base_model || version.baseModel || metadata.ss_base_model_version || metadata['modelspec.architecture'], 200)
    const value = { id: source.id, name: path.basename(source.path), path: source.path, relativePath: relative, folder: folder === '.' ? '' : folder,
      displayName: str(remote.model?.name || managed.model_name || model.name || metadata['modelspec.title'] || metadata.ss_output_name || path.parse(source.path).name, 300),
      size: source.stat.size, mtime: source.stat.mtimeMs, base: base || (folder === '.' ? '未知' : folder.split('/')[0]), baseSource: base ? '元数据' : '目录',
      triggers: strings(version.trainedWords || managed.trained_words || managed.trigger_words || metadata['modelspec.trigger_phrase']), tags: strings([...strings(model.tags), ...strings(managed.tags), ...companions.flatMap(companion => strings(companion.tags))]),
      creator: str(model.creator?.username || version.creator?.username || managed.creator || metadata['modelspec.author'], 200),
      description: plain(model.description || version.description || metadata['modelspec.description']), notes: str(managed.notes, 4000),
      version: str(version.name, 300), modelId: Number(version.modelId) || undefined, versionId: Number(version.id) || undefined, onlineMetadata: !!Number(version.id),
      training: { network: str(metadata.ss_network_module, 200), dim: str(metadata.ss_network_dim, 80), alpha: str(metadata.ss_network_alpha, 80),
        resolution: str(metadata.ss_resolution, 200), epochs: str(metadata.ss_epoch || metadata.ss_num_epochs, 80), steps: str(metadata.ss_steps || metadata.ss_max_train_steps, 80),
        trainingModel: str(metadata.ss_sd_model_name, 300) }, trainingTags, tensorCount: header.tensorCount, metadataError,
      previewUrl: (Array.isArray(version.images) ? version.images : []).find(image => image.type !== 'video' && typeof image.url === 'string')?.url || (typeof managed.preview_url === 'string' && managed.preview_url.startsWith('https:') ? managed.preview_url : ''),
      metadataSources: [header.tensorCount ? 'Safetensors 文件头' : '', ...this.sidecars(source).map(file => path.basename(file.path)), Object.keys(remote).length ? '已缓存的在线资料' : ''].filter(Boolean) }
    if (raw) return { ...value, metadata: Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 64000) : v])) }
    this.cache[source.id] = { signature, value }; return value
  }
  async scanFiles() {
    const found = new Map(); let errors = 0
    this.scanning = true; this.scanError = ''
    try {
      const visit = async (directory, depth, root) => {
        if (this.closed || depth > 12) return
        let files
        try { files = await fsp.readdir(directory, { withFileTypes: true }) } catch { errors++; return }
        for (const file of files) {
          if (this.closed) return
          if (file.isSymbolicLink() || file.name.startsWith('.')) continue
          const filename = path.join(directory, file.name)
          if (file.isDirectory()) await visit(filename, depth + 1, root)
          else if (file.isFile() && MODELS.has(path.extname(file.name).toLowerCase())) {
            try { const source = this.resolve(encodeId(filename)), value = await this.describe(source); found.set(source.id, value); this.entries.set(source.id, value) } catch { errors++ }
            await yieldTurn()
          }
        }
      }
      for (const root of this.roots) await visit(root.path, 0, root)
      if (!this.closed) { this.entries = found; this.cache = Object.fromEntries([...found.keys()].map(id => [id, this.cache[id]])); await this.persistIndex() }
    } catch (e) { this.scanError = e.message }
    finally { this.scanning = false; this.lastScan = Date.now(); this.scanErrors = errors }
    return { total: this.entries.size }
  }
  async refresh() {
    await this.ready
    if (this.fetching()) throw httpError(429, '资料抓取中，结束后可刷新目录')
    if (this.scanning) return { scanning: true }
    this.scan = this.scanFiles(); return { scanning: true }
  }
  mark(id) { return this.marks[id] || { favorite: false, categories: [], note: '' } }
  annotate(id, patch) {
    const task = this.serial.then(async () => {
      await this.ready; this.resolve(id)
      if (this.closed) throw httpError(503, '图库正在重载')
      if (this.loadError) throw httpError(503, 'LoRA 收藏读取异常，原文件已保留')
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw httpError(400, 'LoRA 标记格式错误')
      const value = { ...this.mark(id) }
      if ('favorite' in patch) { if (typeof patch.favorite !== 'boolean') throw httpError(400, '收藏格式错误'); value.favorite = patch.favorite }
      if ('categories' in patch) {
        if (!Array.isArray(patch.categories) || patch.categories.length > 30 || patch.categories.some(c => typeof c !== 'string' || c.length > 80)) throw httpError(400, '分类最多 30 个，每个最多 80 字')
        value.categories = strings(patch.categories)
      }
      if ('note' in patch) { if (typeof patch.note !== 'string' || patch.note.length > 4000) throw httpError(400, '备注最多 4000 字'); value.note = patch.note }
      const next = { ...this.marks, [id]: value }; await atomic(this.annotationFile, { version: 1, items: next }); this.marks = next
      return value
    })
    this.serial = task.catch(() => {}); return task
  }
  async list(params = {}) {
    await this.ready
    if (!this.scanning && !this.fetching() && Date.now() - this.lastScan > 60000) this.scan = this.scanFiles()
    const all = [...this.entries.values()], folders = new Set(), bases = new Set(), categories = new Set(), tags = new Map()
    for (const item of all) { folders.add(item.folder); bases.add(item.base); for (const c of this.mark(item.id).categories || []) categories.add(c) }
    for (const item of this.filtered({ ...params, tags: '' })) {
      for (const tag of new Set((item.tags || []).map(tagKey))) {
        const record = tags.get(tag) || { name: (item.tags || []).find(value => tagKey(value) === tag), count: 0 }
        record.count++; tags.set(tag, record)
      }
    }
    const filtered = this.filtered(params)
    const offset = Math.max(0, Math.floor(Number(params.offset) || 0)), limit = Math.max(1, Math.min(100, Math.floor(Number(params.limit) || 40)))
    return { total: filtered.length, indexed: all.length, scanning: this.scanning, errors: this.scanErrors || 0, error: this.loadError || this.scanError || '', roots: this.roots.map(r => r.path),
      folders: [...folders].filter(Boolean).sort(), bases: [...bases].sort(), categories: [...categories].sort(), tags: [...tags.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)), offset, limit,
      items: filtered.slice(offset, offset + limit).map(item => ({ id: item.id, name: item.name, displayName: item.displayName, relativePath: item.relativePath, base: item.base, folder: item.folder, size: item.size, mtime: item.mtime, ...this.mark(item.id), preview: this.hasPreview(item.id), previewVersion: this.jobs.get(item.id)?.completedAt || item.mtime, onlineMetadata: item.onlineMetadata ?? !!item.versionId })) }
  }
  filtered(params = {}) {
    const q = str(params.q).toLowerCase(), tags = selectedTags(params.tags)
    return [...this.entries.values()].filter(item => {
      const mark = this.mark(item.id)
      return (!params.favorite || params.favorite !== '1' || mark.favorite) && (!params.folder || item.folder === params.folder) && (!params.base || item.base === params.base) &&
        (!params.missing || params.missing !== '1' || !item.versionId || !this.hasPreview(item.id) || !(item.tags || []).length) &&
        (!tags.length || tags.some(tag => (item.tags || []).some(value => tagKey(value) === tag))) &&
        (!params.category || (mark.categories || []).includes(params.category)) && (!q || `${item.name}\n${item.displayName}\n${item.relativePath}\n${item.base}\n${item.triggers.join(' ')}\n${item.tags.join(' ')}\n${mark.note}\n${(mark.categories || []).join(' ')}`.toLowerCase().includes(q))
    }).sort((a, b) => params.sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : b.mtime - a.mtime)
  }
  preview(id) {
    const source = this.resolve(id), direct = this.localPreview(source)
    if (direct) return direct
    const metadata = this.sidecars(source).map(file => { try { return json(fs.readFileSync(file.real, 'utf8')) } catch { return {} } }).find(c => c.preview_url) || {}
    const local = this.localPreview(source, metadata)
    if (local) return local
    const cached = path.join(this.directory, this.key(source) + '.preview')
    try { const stat = fs.lstatSync(cached); if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 20 * 1024 * 1024) return { path: cached, real: cached, stat } } catch { /* no preview */ }
    throw httpError(404, '尚无预览图，可点击抓取预览与资料')
  }
  hasPreview(id) { try { this.preview(id); return true } catch { return false } }
  async detail(id) {
    await this.ready; const source = this.resolve(id), data = await this.describe(source, true)
    return { ...data, ...this.mark(id), preview: this.hasPreview(id), context: this.context(data), fetch: this.job(id) }
  }
  context(data) {
    const mark = this.mark(data.id)
    return ['LoRA：' + data.displayName, '文件：' + data.relativePath, '本地路径：' + data.path, '底模：' + data.base + '（' + data.baseSource + '）',
      '触发词：' + (data.triggers.join(', ') || '未记录'), '调用参考：<lora:' + data.relativePath.replace(/\.[^.]+$/, '') + ':1>',
      '分类：' + (mark.categories || []).join('、'), data.description ? '说明：' + data.description.slice(0, 3000) : '', mark.note ? '备注：' + mark.note : '',
      '权重 1 仅为调用参考，请根据模型说明调整。'].filter(Boolean).join('\n')
  }
  persistIndex() {
    const task = this.cacheSerial.then(() => atomic(this.cacheFile, { version: 1, items: this.cache }))
    this.cacheSerial = task.catch(() => {}); return task
  }
  fetching() { return ['running', 'cancelling'].includes(this.batch?.state) || [...this.jobs.values()].some(job => job.state === 'running') }
  batchStatus() {
    const job = this.batch
    if (!job) return null
    return { id: job.id, state: job.state, mode: job.mode, total: job.total, completed: job.completed, succeeded: job.succeeded, failed: job.failed, skipped: job.skipped,
      current: job.current, stage: job.current ? this.job(job.current.id)?.stage || '读取本地资料' : '', errors: job.errors || [], error: job.error || '', startedAt: job.startedAt, completedAt: job.completedAt }
  }
  persistBatch() {
    const snapshot = this.batchStatus(), task = this.batchSerial.then(() => atomic(this.batchFile, { version: 1, job: snapshot }))
    this.batchSerial = task.catch(() => {}); return task
  }
  async startBatch(options = {}) {
    await this.ready; await this.scan
    if (this.closed) throw httpError(503, '图库正在重载')
    if (this.fetching()) throw httpError(429, '已有 LoRA 抓取任务正在进行')
    const mode = options.mode || 'missing'
    if (!['missing', 'all'].includes(mode) || options.filters && (typeof options.filters !== 'object' || Array.isArray(options.filters))) throw httpError(400, '抓取范围或模式错误')
    const filters = Object.fromEntries(['q', 'folder', 'base', 'category', 'favorite', 'missing', 'sort'].map(key => [key, str(options.filters?.[key], 8000)]))
    filters.tags = selectedTags(options.filters?.tags)
    // Snapshot every matching ID before any metadata changes affect the filter.
    const targets = this.filtered(filters).map(item => item.id)
    const batch = { id: randomUUID(), mode, state: 'running', total: targets.length, completed: 0, succeeded: 0, failed: 0, skipped: 0,
      errors: [], current: null, startedAt: Date.now(), controller: new AbortController() }
    this.batch = batch
    batch.task = (async () => {
      await this.persistBatch()
      let failures = 0
      for (const id of targets) {
        if (batch.controller.signal.aborted || this.closed) break
        const source = this.resolveOrNull(id), item = this.entries.get(id)
        batch.current = { id, name: item?.displayName || item?.name || 'LoRA' }
        if (mode === 'missing' && source && item?.versionId && item.tags?.length && this.hasPreview(id)) { batch.skipped++; batch.completed++; await yieldTurn(); continue }
        await this.persistBatch()
        let result
        try {
          await this.fetch(id, { mode: mode === 'all' ? 'refresh' : 'missing' }, batch)
          await this.jobs.get(id).task; result = this.job(id)
        } catch (error) { result = { state: 'error', error: error.message, status: error.status } }
        if (batch.controller.signal.aborted || this.closed) break
        batch.completed++
        if (result.state === 'done') { batch.succeeded++; failures = 0 }
        else {
          batch.failed++; failures++
          if (batch.errors.length < 100) batch.errors.push({ id, name: batch.current.name, error: result.error || '资料抓取失败' })
          // A missing public model is per-file. Stop on rate limiting, access restrictions or repeated connection failures.
          if ([401, 403, 429].includes(result.status) || failures >= 3 && !result.status) { batch.error = '抓取已暂停：' + result.error; batch.state = 'error'; break }
        }
        await this.persistBatch()
        if (batch.completed < batch.total) await delay(750, undefined, { signal: batch.controller.signal }).catch(() => {})
      }
      if (batch.state !== 'error') batch.state = batch.controller.signal.aborted || this.closed ? 'cancelled' : 'done'
    })().catch(error => { batch.state = 'error'; batch.error = error.message }).finally(async () => {
      batch.current = null; batch.completedAt = Date.now()
      try { await this.persistIndex(); await this.persistBatch() } catch (error) { batch.state = 'error'; batch.error = '抓取结果保存失败：' + error.message }
    })
    return this.batchStatus()
  }
  resolveOrNull(id) { try { return this.resolve(id) } catch { return null } }
  cancelBatch() {
    const batch = this.batch
    if (batch?.state === 'running') {
      batch.state = 'cancelling'; batch.controller.abort()
      const job = this.jobs.get(batch.current?.id)
      if (job?.state === 'running') { job.controller.abort(); job.validation?.child?.kill() }
    }
    return this.batchStatus()
  }
  job(id) { const job = this.jobs.get(id); return job ? { state: job.state, error: job.error, status: job.status, stage: job.stage, warning: job.warning, completedAt: job.completedAt } : null }
  async fetch(id, options = {}, owner = null) {
    await this.ready
    await this.scan
    if (this.closed) throw httpError(503, '图库正在重载')
    if (['running', 'cancelling'].includes(this.batch?.state) && owner !== this.batch) throw httpError(429, '批量抓取正在进行，请等待或先取消')
    const source = this.resolve(id), current = this.jobs.get(id)
    if (current?.state === 'running') return this.job(id)
    if ([...this.jobs.values()].some(j => j.state === 'running')) throw httpError(429, '正在抓取另一份 LoRA 资料，请稍后重试')
    const job = { state: 'running', stage: '读取本地资料', controller: new AbortController() }; this.jobs.set(id, job)
    while (this.jobs.size > 100) { const old = [...this.jobs].find(([, j]) => j.state !== 'running'); if (!old) break; this.jobs.delete(old[0]) }
    job.task = (async () => {
      let data = await this.describe(source, true), remote
      const force = options.mode === 'refresh', missing = options.mode === 'missing'
      if (force || !data.previewUrl || missing && (!data.versionId || !data.modelId && !data.tags.length)) {
        let url
        if (data.versionId) url = 'https://civitai.com/api/v1/model-versions/' + data.versionId
        else {
          job.stage = '计算文件哈希'; const hash = createHash('sha256'), stream = fs.createReadStream(source.real, { signal: job.controller.signal })
          for await (const chunk of stream) hash.update(chunk)
          url = 'https://civitai.com/api/v1/model-versions/by-hash/' + hash.digest('hex')
        }
        job.stage = '查询模型资料'; remote = json((await this.download(url, 'json', job.controller.signal)).toString('utf8'))
        if (!remote.id) throw new Error('在线模型资料格式错误')
        data.previewUrl = (Array.isArray(remote.images) ? remote.images : []).find(image => image.type !== 'video' && typeof image.url === 'string')?.url
      }
      const validate = () => { if (this.closed || job.controller.signal.aborted || this.key(this.resolve(id)) !== this.key(source)) throw new Error('任务已取消或 LoRA 已变化，请重试') }
      validate()
      // Metadata is useful even if no image exists or its download fails.
      if (remote) {
        await atomic(path.join(this.directory, this.key(source) + '.json'), remote)
        delete this.cache[id]; this.entries.set(id, await this.describe(source)); await this.persistIndex()
        data = await this.describe(source, true)
      }
      if ((force || missing) && data.modelId && !data.tags.length) {
        job.stage = '查询模型分类标签'
        const model = json((await this.download('https://civitai.com/api/v1/models/' + data.modelId, 'json', job.controller.signal)).toString('utf8'))
        if (Number(model.id) !== data.modelId) throw new Error('在线模型分类资料格式错误')
        validate()
        const cached = this.remote(source)
        const enriched = { ...cached, model: { ...object(cached.model), name: str(model.name, 300), tags: strings(model.tags), description: str(model.description, 40000), creator: object(model.creator) } }
        await atomic(path.join(this.directory, this.key(source) + '.json'), enriched)
        delete this.cache[id]; this.entries.set(id, await this.describe(source)); await this.persistIndex()
        data = await this.describe(source, true)
      }
      if (missing && this.hasPreview(id)) { job.state = 'done'; job.stage = '资料已补全，保留已有预览'; return }
      if (!data.previewUrl) {
        if (remote || data.versionId) { job.state = 'done'; job.stage = '元数据已保存'; job.warning = '公开资料没有预览图'; return }
        throw new Error('模型资料中没有可用预览图')
      }
      job.stage = '下载预览'; const image = await this.download(data.previewUrl, 'image', job.controller.signal); imageType(image)
      validate()
      const target = path.join(this.directory, this.key(source) + '.preview'), temp = target + '.' + randomUUID() + '.tmp', converted = temp + '.webp'
      await fsp.mkdir(this.directory, { recursive: true })
      try {
        await fsp.writeFile(temp, image)
        // Decode before publication and retain only the compact thumbnail, not a full-size remote image.
        job.validation = { source: temp, target: converted }
        await this.thumbs.generate(job.validation)
        validate()
        await fsp.rename(converted, target)
      } finally { await fsp.rm(temp, { force: true }).catch(() => {}); await fsp.rm(converted, { force: true }).catch(() => {}) }
      delete this.cache[id]; const value = await this.describe(source); this.entries.set(id, value)
      await this.persistIndex()
      job.state = 'done'; job.stage = '预览已缓存'
    })().catch(error => { job.state = job.controller.signal.aborted ? 'cancelled' : 'error'; job.error = error.message; job.status = error.status }).finally(() => { job.completedAt = Date.now() })
    return this.job(id)
  }
  async close() {
    this.closed = true; this.thumbs.close()
    this.cancelBatch()
    await this.ready
    for (const job of this.jobs.values()) { job.controller.abort(); job.validation?.child?.kill() }
    await Promise.allSettled([this.scan, this.serial, this.batch?.task, ...[...this.jobs.values()].map(job => job.task)])
    await Promise.allSettled([this.batchSerial, this.cacheSerial])
  }
}
