import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { safeJson } from './png.js'
import { httpError } from './store.js'

const EDITABLE = new Set(['text', 'positive', 'negative', 'positive_prompt', 'negative_prompt', 'seed', 'noise_seed', 'steps', 'cfg', 'cfg_scale', 'sampler_name', 'scheduler', 'denoise', 'width', 'height', 'strength_model', 'strength_clip', 'strength', 'lora_name', 'ckpt_name', 'unet_name', 'clip_name', 'vae_name'])
export class Reuse {
  constructor(store) { this.store = store; this.drafts = new Map(); this.controllers = new Set(); this.closed = false }
  async prepare(id) {
    const detail = await this.store.detail(id)
    let graph = null
    try { graph = safeJson(await this.store.raw(id, 'prompt')) } catch (e) { if (e.status !== 404) throw e }
    if (!graph || Array.isArray(graph) || !Object.values(graph).some(n => n?.class_type)) graph = null
    const draftId = randomUUID(), fields = []
    if (graph) for (const [node, definition] of Object.entries(graph)) for (const [key, value] of Object.entries(definition.inputs || {})) {
      if (EDITABLE.has(key) && ['string', 'number'].includes(typeof value)) fields.push({ node, key, value, type: typeof value,
        label: `#${node} ${definition._meta?.title || definition.class_type} · ${key}` })
    }
    while (this.drafts.size >= 30) this.drafts.delete(this.drafts.keys().next().value)
    this.drafts.set(draftId, { id, graph, fields, stamp: this.store.signature(detail.path, this.store.resolve(id).stat) })
    return { draftId, name: detail.name, fields, hasGraph: !!graph, positive: detail.positive || '', negative: detail.negative || '', sampling: detail.sampling || {}, models: detail.models, loras: detail.loras,
      note: graph ? '已保留原始节点和模型连接。编辑下列参数后可下载工作流，或通过已有生成工作台提交。' : '图片未保存 API 工作流；可复用提示词和参数摘要，或下载已保存的界面 workflow。' }
  }
  async materialize(body) {
    const draft = this.drafts.get(body?.draftId)
    if (!draft) throw httpError(404, '复用草稿已过期，请重新从图片带入')
    const source = this.store.resolve(draft.id)
    if (this.store.signature(source.path, source.stat) !== draft.stamp) throw httpError(409, '原始图片参数已变化，请重新带入')
    if (!draft.graph) throw httpError(400, '这张图片未保存 API 工作流，可复制提示词摘要')
    const graph = structuredClone(draft.graph)
    if (body.edits !== undefined && (!Array.isArray(body.edits) || body.edits.length > 500)) throw httpError(400, '编辑参数格式错误')
    for (const edit of body.edits || []) {
      const field = draft.fields.find(f => f.node === edit.node && f.key === edit.key)
      if (!field || typeof edit.value !== field.type || (typeof edit.value === 'number' && !Number.isFinite(edit.value)) || (typeof edit.value === 'string' && edit.value.length > 64000)) throw httpError(400, '参数类型或内容错误')
      graph[field.node].inputs[field.key] = edit.value
    }
    return graph
  }
  async submit(body, execute) {
    if (this.closed) throw httpError(503, '图库正在重载')
    const draft = this.drafts.get(body?.draftId)
    if (draft?.submitted) return draft.submitted
    if (draft?.pending) throw httpError(409, '该草稿正在提交，请稍候')
    const graph = await this.materialize(body)
    for (const node of Object.values(graph)) for (const [key, value] of Object.entries(node.inputs || {})) {
      if (['seed', 'noise_seed'].includes(key) && typeof value === 'string' && /^\d{16,}$/.test(value) && BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) throw httpError(400, '此 seed 超出工作台的精确整数范围；请换一个较小 seed，或下载工作流在 ComfyUI 中使用')
      if (['seed', 'noise_seed'].includes(key) && typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) node.inputs[key] = Number(value)
    }
    if (draft.pending) throw httpError(409, '该草稿正在提交，请稍候')
    draft.pending = true
    try {
    const directory = path.join(this.store.config.cacheDir, 'reuse'), filename = path.join(directory, `${randomUUID()}.json`)
    await fs.mkdir(directory, { recursive: true }); await fs.writeFile(filename, JSON.stringify(graph))
    const controller = new AbortController(); this.controllers.add(controller)
    try {
      if (!execute) {
        const entry = this.store.config.workbenchEntry || path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-comfyui-workbench', 'lib', 'comfy-tools.js')
        let module
        try { module = await import(pathToFileURL(entry).href) } catch { throw httpError(503, '未找到本地生成工作台；仍可下载工作流后导入 ComfyUI') }
        execute = (args, signal) => module.createComfyUIWorkflowTool({}).execute(args, { signal, agent: { cwd: directory } })
      }
      const result = await execute({ action: 'run', workflow_path: filename, wait: false }, controller.signal)
      if (!result.success) throw httpError(400, result.text || '工作台未接受任务，请检查 ComfyUI 是否启动及所需节点和模型')
      draft.submitted = { promptId: result.prompt_id, status: result.status, message: result.text }
      return draft.submitted
    } finally { this.controllers.delete(controller) }
    } finally { draft.pending = false }
  }
  close() { this.closed = true; for (const controller of this.controllers) controller.abort() }
}
