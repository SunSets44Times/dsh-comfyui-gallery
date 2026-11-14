/**
 * Workflow index: saved ComfyUI workflow files, each matched to the images it produced.
 *
 * Two identities are computed on purpose, because the two sides hold different data:
 *
 *   - `uiSig` comes from the UI graph (`workflow` chunk / .json file) and is what
 *     matches a saved file to images — both carry the same node types and link
 *     topology, so node ids, coordinates and widget values can all be ignored.
 *   - `apiSig` comes from the API graph (`prompt` chunk) and only groups images,
 *     for the workflows that were executed but never saved.
 *
 * Seeds, numeric tuning (steps/cfg), prompt wording and node coordinates are
 * excluded from both, so re-running one template with a new seed or new wording
 * stays a single entry. Model files are included: swapping checkpoint or LoRA is
 * a different workflow, not a new run of the same one.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { safeJson } from './png.js'
import { excerpt } from './extract.js'
import { explainWorkflow } from './nodes.js'

const present = filename => { try { return fs.statSync(filename).isDirectory() } catch { return false } }
const within = (root, filename) => { const rel = path.relative(root, filename); return rel === '' || rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) }
const base = value => String(value).split(/[\\/]/).pop()
const fail = (status, message) => Object.assign(new Error(message), { status })

// Model inputs define which files a workflow needs; they belong in the identity.
const MODEL_INPUT = /^(ckpt_name|checkpoint_name|unet_name|diffusion_model_name|clip_name\d*|vae_name|lora_name|control_net_name|upscale_model_name|style_model_name|model_name|t5xxl|ipadapter.*)$/
const LINK = value => Array.isArray(value) && value.length >= 2 && value[1] !== undefined

const digest = value => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16)

/** Identity of an executed API graph. Empty when there is no usable graph. */
export function promptSignature(prompt) {
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) return ''
  const entries = Object.entries(prompt).filter(([, node]) => node && typeof node === 'object' && node.class_type)
  if (!entries.length) return ''
  const key = new Map()
  for (const [id, node] of entries) {
    const models = Object.entries(node.inputs || {})
      .filter(([name, value]) => MODEL_INPUT.test(name) && typeof value === 'string' && value)
      .map(([name, value]) => `${name}=${base(value)}`)
      .sort()
    key.set(String(id), `${node.class_type}(${models.join(',')})`)
  }
  const nodes = [...key.values()].sort()
  const edges = []
  for (const [id, node] of entries) {
    for (const [name, value] of Object.entries(node.inputs || {})) {
      if (!LINK(value)) continue
      const origin = key.get(String(value[0]))
      if (!origin) continue
      edges.push(`${origin}->${name}->${key.get(String(id))}`)
    }
  }
  edges.sort()
  return digest({ nodes, edges })
}

/** Identity of a UI graph: node types plus link topology, ignoring layout and widgets. */
export function uiSignature(workflow) {
  if (!workflow || typeof workflow !== 'object') return ''
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes.filter(node => node && typeof node === 'object') : []
  if (!nodes.length) return ''
  const type = new Map(nodes.map(node => [String(node.id), String(node.type || '')]))
  const types = [...type.values()].sort()
  const links = Array.isArray(workflow.links) ? workflow.links : []
  const edges = []
  for (const link of links) {
    // ComfyUI has shipped both the array and the object shape for `links`.
    const row = Array.isArray(link) ? { origin: link[1], originSlot: link[2], target: link[3], targetSlot: link[4] }
      : link && typeof link === 'object' ? { origin: link.origin_id, originSlot: link.origin_slot, target: link.target_id, targetSlot: link.target_slot } : null
    if (!row) continue
    const from = type.get(String(row.origin)), to = type.get(String(row.target))
    if (from === undefined || to === undefined) continue
    edges.push(`${from}:${row.originSlot}->${to}:${row.targetSlot}`)
  }
  edges.sort()
  const groups = (Array.isArray(workflow.groups) ? workflow.groups : []).map(group => String(group?.title || '')).filter(Boolean).sort()
  return digest({ types, edges, groups })
}

/** First non-empty group title, used as a readable name for unsaved workflows. */
export function workflowTitle(workflow) {
  const groups = Array.isArray(workflow?.groups) ? workflow.groups : []
  for (const group of groups) if (typeof group?.title === 'string' && group.title.trim()) return group.title.trim().slice(0, 80)
  return ''
}

function workflowRoots(config) {
  if (Array.isArray(config.workflowRoots)) {
    return [...new Set(config.workflowRoots.filter(p => typeof p === 'string' && path.isAbsolute(p)).map(p => path.resolve(p)))].filter(present)
  }
  const comfy = []
  if (typeof config.comfyRoot === 'string' && path.isAbsolute(config.comfyRoot)) comfy.push(config.comfyRoot)
  if (typeof config.python === 'string' && path.isAbsolute(config.python)) comfy.push(path.join(path.dirname(path.dirname(config.python)), 'ComfyUI'))
  // A gallery usually points at <ComfyUI>/output, so its parent is the install root.
  for (const root of config.roots || []) comfy.push(path.dirname(root))
  const roots = comfy.map(root => path.join(root, 'user', 'default', 'workflows'))
  return [...new Set(roots)].filter(present)
}

export class Workflows {
  constructor(store) {
    this.store = store
    this.roots = workflowRoots(store.config)
    this.files = []
    this.scannedAt = 0
    this.scanning = null
  }

  /** Saved .json files, re-read at most once per interval. */
  async scan(force = false) {
    if (!force && Date.now() - this.scannedAt < this.store.config.scanIntervalMs && this.scannedAt) return this.files
    if (this.scanning) return this.scanning
    this.scanning = (async () => {
      const found = []
      const walk = async (directory, root, depth) => {
        let children
        try { children = await fsp.readdir(directory, { withFileTypes: true }) } catch { return }
        for (const child of children) {
          const filename = path.join(directory, child.name)
          if (child.isDirectory()) {
            if (depth < 6 && !child.isSymbolicLink() && !child.name.startsWith('.')) await walk(filename, root, depth + 1)
            continue
          }
          if (!child.isFile() || path.extname(child.name).toLowerCase() !== '.json') continue
          // ComfyUI keeps its own `.index.json` beside the workflows; it carries no graph.
          if (child.name.startsWith('.')) continue
          let stat
          try { stat = await fsp.stat(filename) } catch { continue }
          if (stat.size > 8 * 1024 * 1024) continue
          let workflow
          try { workflow = safeJson(await fsp.readFile(filename, 'utf8')) } catch { continue }
          const uiSig = uiSignature(workflow)
          if (!uiSig) continue
          // Explaining once per scan keeps the list cards cheap; the detail view re-reads.
          const explained = explainWorkflow(workflow, null)
          const checkpoint = explained.models.checkpoint[0] || explained.models.unet[0] || ''
          found.push({
            path: filename, real: (() => { try { return fs.realpathSync(filename) } catch { return filename } })()
            , root, name: path.relative(root, filename).replace(/\.json$/i, ''),
            mtime: stat.mtimeMs, size: stat.size, uiSig,
            nodeCount: explained.nodes.length,
            loraCount: explained.loras.length,
            checkpoint: checkpoint ? base(checkpoint) : '',
            title: workflowTitle(workflow)
          })
        }
      }
      for (const root of this.roots) await walk(root, root, 0)
      found.sort((a, b) => b.mtime - a.mtime)
      this.files = found
      this.scannedAt = Date.now()
      return found
    })().finally(() => { this.scanning = null })
    return this.scanning
  }

  /** Group indexed images by API identity. */
  clusters() {
    const groups = new Map()
    for (const entry of this.store.entries.values()) {
      const sig = entry.meta?.wfSig
      if (!sig) continue
      let group = groups.get(sig)
      if (!group) { group = { sig, uiSig: entry.meta?.uiSig || '', title: entry.meta?.wfTitle || '', images: [] }; groups.set(sig, group) }
      if (!group.uiSig && entry.meta?.uiSig) group.uiSig = entry.meta.uiSig
      if (!group.title && entry.meta?.wfTitle) group.title = entry.meta.wfTitle
      group.images.push(entry)
    }
    for (const group of groups.values()) group.images.sort((a, b) => b.mtime - a.mtime)
    return groups
  }

  /**
   * Saved files become the list. Image-only clusters are appended as "未归档"
   * only when `workflowFromImages` is on; by default the page shows saved
   * workflows alone.
   */
  async list(params = {}) {
    await this.store.ready
    // `ready` resolves before the background scan does; the list would be empty.
    if (this.store.scanPromise) await this.store.scanPromise
    const files = await this.scan()
    const includeImages = this.store.config.workflowFromImages === true
    // 图片按 UI 指纹挂到已保存的工作流上：这一步和"未归档"开关无关，
    // 否则关掉开关连例图和出图数都会消失。
    const byUisig = new Map()
    for (const entry of this.store.entries.values()) {
      const sig = entry.meta?.uiSig
      if (!sig) continue
      const bucket = byUisig.get(sig)
      if (bucket) bucket.push(entry)
      else byUisig.set(sig, [entry])
    }
    const entries = []
    for (const file of files) {
      const matched = byUisig.get(file.uiSig) || []
      const images = matched.slice().sort((a, b) => b.mtime - a.mtime)
      entries.push({
        id: `f.${Buffer.from(file.path, 'utf8').toString('base64url')}`,
        kind: 'file', name: file.name, title: file.title,
        mtime: file.mtime, nodeCount: file.nodeCount,
        loraCount: file.loraCount, checkpoint: file.checkpoint,
        imageCount: images.length,
        example: images.length ? Buffer.from(images[0].path, 'utf8').toString('base64url') : null,
        mtimeImage: images.length ? images[0].mtime : null
      })
    }
    const savedSignatures = new Set(files.map(file => file.uiSig))
    if (includeImages) for (const group of this.clusters().values()) {
      // 已经挂在已保存工作流下的图，不再单独列一次
      if (group.uiSig && savedSignatures.has(group.uiSig)) continue
      const latest = group.images[0]
      entries.push({
        id: `c.${group.sig}`,
        kind: 'cluster',
        name: group.title || excerpt(latest?.meta?.positive, 60) || `未命名工作流 ${group.sig.slice(0, 6)}`,
        title: group.title, mtime: latest?.mtime || 0,
        nodeCount: 0,
        // Image metadata already carries the LoRA names, so no extra parsing is needed.
        loraCount: new Set(group.images.flatMap(entry => entry.meta?.loras || [])).size,
        checkpoint: '',
        imageCount: group.images.length,
        example: latest ? Buffer.from(latest.path, 'utf8').toString('base64url') : null,
        mtimeImage: latest?.mtime || null
      })
    }
    const q = String(params.q || '').trim().toLocaleLowerCase()
    const filtered = q ? entries.filter(item => `${item.name}\n${item.title}`.toLocaleLowerCase().includes(q)) : entries
    const sort = String(params.sort || 'count')
    filtered.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'date' ? b.mtime - a.mtime : b.imageCount - a.imageCount || b.mtime - a.mtime || a.name.localeCompare(b.name))
    const indexed = [...this.store.entries.values()].filter(entry => entry.meta?.wfSig).length
    const limit = Math.min(2000, Math.max(1, Math.floor(Number(params.limit)) || 500))
    return {
      total: filtered.length,
      saved: files.length,
      unsaved: entries.filter(item => item.kind === 'cluster').length,
      imageWorkflows: includeImages,
      roots: this.roots,
      indexed, totalImages: this.store.entries.size,
      scanning: !!this.scanning,
      items: filtered.slice(0, limit)
    }
  }

  parseId(id) {
    if (typeof id !== 'string' || id.length > 16384) throw fail(400, '工作流 id 格式错误')
    if (id.startsWith('f.')) return { kind: 'file', value: Buffer.from(id.slice(2), 'base64url').toString('utf8') }
    if (id.startsWith('c.')) return { kind: 'cluster', value: id.slice(2) }
    throw fail(400, '工作流 id 格式错误')
  }

  async item(id) {
    await this.store.ready
    if (this.store.scanPromise) await this.store.scanPromise
    const parsed = this.parseId(id)
    if (parsed.kind === 'file') {
      const files = await this.scan()
      const file = files.find(row => row.path === parsed.value)
      if (!file) throw fail(404, '工作流文件已移动或删除')
      const images = [...this.store.entries.values()].filter(entry => entry.meta?.uiSig === file.uiSig).sort((a, b) => b.mtime - a.mtime)
      // Re-read here rather than keeping 287 parsed graphs in memory.
      const graph = explainWorkflow(safeJson(await fsp.readFile(file.real, 'utf8')), null)
      return {
        id, kind: 'file', name: file.name, title: file.title, path: file.path,
        mtime: file.mtime, size: file.size, nodeCount: file.nodeCount,
        imageCount: images.length,
        example: images.length ? Buffer.from(images[0].path, 'utf8').toString('base64url') : null,
        graph,
        images: images.slice(0, 120).map(entry => ({ id: Buffer.from(entry.path, 'utf8').toString('base64url'), name: entry.name, mtime: entry.mtime, w: entry.meta?.width, h: entry.meta?.height, excerpt: excerpt(entry.meta?.positive, 120) }))
      }
    }
    if (this.store.config.workflowFromImages !== true) throw fail(404, '已关闭「从图片读取工作流」。需要在配置里打开 workflowFromImages 才能查看这类工作流')
    const group = this.clusters().get(parsed.value)
    if (!group) throw fail(404, '没有找到这个工作流，可能对应的图片已删除或尚未建立索引')
    const images = group.images
    // The graph lives inside the newest image of the group.
    let graph = { nodes: [], loras: [], models: { checkpoint: [], unet: [], clip: [], vae: [], other: [] }, categories: [] }
    if (images.length) {
      try {
        const blob = this.store.blobs(this.store.resolve(Buffer.from(images[0].path, 'utf8').toString('base64url')))
        graph = explainWorkflow(safeJson(blob.rawWorkflow), safeJson(blob.rawPrompt))
      } catch { /* unreadable image: keep the empty graph */ }
    }
    return {
      id, kind: 'cluster', name: group.title || excerpt(images[0]?.meta?.positive, 60) || `未命名工作流 ${group.sig.slice(0, 6)}`,
      title: group.title, path: null, mtime: images[0]?.mtime || 0, size: 0,
      nodeCount: graph.nodes.length, imageCount: images.length,
      example: images.length ? Buffer.from(images[0].path, 'utf8').toString('base64url') : null,
      graph,
      images: images.slice(0, 120).map(entry => ({ id: Buffer.from(entry.path, 'utf8').toString('base64url'), name: entry.name, mtime: entry.mtime, w: entry.meta?.width, h: entry.meta?.height, excerpt: excerpt(entry.meta?.positive, 120) }))
    }
  }

  /** Raw workflow JSON: the saved file for `f.`, or the newest image's embedded graph for `c.`. */
  async raw(id) {
    await this.store.ready
    const parsed = this.parseId(id)
    if (parsed.kind === 'file') {
      const files = await this.scan()
      const file = files.find(row => row.path === parsed.value)
      if (!file) throw fail(404, '工作流文件已移动或删除')
      return { name: `${file.name}.json`, text: await fsp.readFile(file.real, 'utf8') }
    }
    if (this.store.config.workflowFromImages !== true) throw fail(404, '已关闭「从图片读取工作流」，无法导出')
    const group = this.clusters().get(parsed.value)
    if (!group?.images.length) throw fail(404, '没有找到可导出的工作流')
    const blob = this.store.blobs(this.store.resolve(Buffer.from(group.images[0].path, 'utf8').toString('base64url')))
    if (!blob.rawWorkflow) throw fail(404, '这张图片没有保存工作流数据')
    return { name: base(group.images[0].path).replace(/\.[^.]+$/, '') + '.json', text: blob.rawWorkflow }
  }
}

export { workflowRoots, within }
