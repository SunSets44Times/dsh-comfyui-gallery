import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { encodeId, httpError } from './store.js'

function basename(name) {
  if (typeof name !== 'string' || name.length > 1024) throw httpError(400, '图片名称格式错误')
  let stem = path.parse(path.win32.basename(name.replace(/\\/g, '/'))).name
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 100).replace(/[. ]+$/g, '')
  if (!stem || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(stem)) stem = '上传图片'
  return stem
}

// Only completed, registered upload jobs can be imported; captions never come from the request.
export class Imports {
  constructor(store, interrogator, library) {
    this.store = store; this.interrogator = interrogator; this.library = library
    this.pending = new Map(); this.saved = new Map(); this.closed = false
  }
  async save(body) {
    if (this.closed) throw httpError(503, '图库正在重载')
    await this.interrogator.ready
    const job = this.interrogator.jobs.get(body.jobId)
    if (typeof body.id !== 'string' || !body.id.startsWith('upload:') || !job || job.imageId !== body.id) throw httpError(400, '请选择当前上传图片的反推结果')
    if (job.state !== 'done' || typeof job.result?.text !== 'string') throw httpError(409, '请等待反推完成后保存')
    const stem = basename(body.name ?? '上传图片')
    if (job.savedImport) { this.store.resolve(job.savedImport.id); return job.savedImport }
    if (this.saved.has(job.id)) {
      const result = this.saved.get(job.id)
      this.store.resolve(result.id)
      return result
    }
    if (this.pending.has(job.id)) return this.pending.get(job.id)
    const task = this.publish(job, stem, body.name || '上传图片')
    this.pending.set(job.id, task)
    try {
      const result = await task
      job.savedImport = result
      await this.interrogator.remember()
      this.saved.set(job.id, result)
      while (this.saved.size > 100) this.saved.delete(this.saved.keys().next().value)
      return result
    } finally { this.pending.delete(job.id) }
  }
  async publish(job, stem, originalName) {
    await this.store.ready; await this.library.ready
    if (this.library.loadError) throw httpError(503, '收藏文件读取异常，请检查 library.json 后重试')
    const root = this.store.realRoots[0]
    if (!root) throw httpError(503, '请先配置一个现有图库目录')
    const source = this.interrogator.uploads.resolve(job.imageId)
    if (source.real !== job.source.real || source.stat.size !== job.source.stat.size || source.stat.mtimeMs !== job.source.stat.mtimeMs) throw httpError(409, '上传图片已变化，请重新反推')
    // Snapshot before further awaits so removing the temporary upload cannot corrupt a save.
    const bytes = await fs.readFile(source.real)
    const directory = path.join(root.root, '图库导入')
    await fs.mkdir(directory, { recursive: true })
    const stat = await fs.lstat(directory), real = await fs.realpath(directory), rel = path.relative(root.real, real)
    if (!stat.isDirectory() || stat.isSymbolicLink() || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw httpError(403, '导入目录应位于当前图库中，请检查“图库导入”文件夹')
    const uuid = randomUUID(), stage = await fs.mkdtemp(path.join(directory, '.gallery-import-'))
    const target = path.join(directory, new Date().toISOString().slice(0, 10) + '-' + uuid)
    const extension = source.mediaType === 'image/gif' ? '.png' : path.extname(source.real).toLowerCase()
    const name = stem + extension, finalImage = path.join(target, name), id = encodeId(finalImage)
    let published = false, committed = false
    try {
      if (source.mediaType === 'image/gif') {
        const input = path.join(stage, 'source.upload')
        await fs.writeFile(input, bytes, { flag: 'wx' })
        await this.interrogator.runProcess(['--export-first-frame'], { image: input, output: path.join(stage, name) }, 15000)
        await fs.rm(input)
      } else await fs.writeFile(path.join(stage, name), bytes, { flag: 'wx' })
      const generated = { text: job.result.text, tags: job.result.tags.map(t => t.tag), model: job.model.name, options: job.options }
      const metadata = { positive: generated.text, negative: '', galleryImport: { version: 1, originalName, savedAt: new Date().toISOString(),
        model: job.model.name, options: job.options, result: job.result, firstFrame: source.mediaType === 'image/gif' } }
      await fs.writeFile(path.join(stage, stem + '.txt'), generated.text, { flag: 'wx' })
      await fs.writeFile(path.join(stage, stem + '.json'), JSON.stringify(metadata, null, 2), { flag: 'wx' })
      // Publish the image and its companions together. Scans ignore staging directories.
      await fs.rename(stage, target); published = true
      await this.store.refresh()
      await this.store.detail(id)
      await this.library.update(id, generated, true)
      committed = true
      // The index is a rebuildable cache; an index write error must not undo a durable import.
      await this.store.flush().catch(error => console.warn('[comfyui-gallery] import index:', error.message))
      return { id, name, directory: '图库导入', caption: stem + '.txt', firstFrame: source.mediaType === 'image/gif' }
    } finally {
      if (!committed) {
        this.store.entries.delete(finalImage); this.store.details.delete(finalImage); this.store.markDirty()
        // Both directories were created by this operation beneath the checked gallery root.
        await fs.rm(published ? target : stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      }
    }
  }
  async close() { this.closed = true; await Promise.allSettled([...this.pending.values()]) }
}
