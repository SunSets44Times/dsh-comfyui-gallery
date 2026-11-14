/**
 * Readable explanations for the nodes inside a workflow.
 *
 * Works from the saved UI graph that ComfyUI writes (nodes + widgets_values). The
 * API graph is only used when a workflow exists solely inside an image and carries
 * no UI graph, because named inputs there are unambiguous.
 *
 * Anything not in the catalog is still listed: an unknown custom node keeps its
 * type name and shows its first few widget values, so nothing silently disappears.
 */

// `widgets` lists the saved widget order for the types where a value's meaning
// matters (model filenames, LoRA strength, sampler settings).
const CATALOG = [
  // 加载
  { match: /^CheckpointLoader(Simple)?$/, label: '底模加载', role: '加载 checkpoint，同时产出 MODEL / CLIP / VAE', category: '加载', widgets: ['ckpt_name'] },
  { match: /^unCLIPCheckpointLoader$/, label: '底模加载', role: '加载 unCLIP checkpoint', category: '加载', widgets: ['ckpt_name'] },
  { match: /^ImageOnlyCheckpointLoader$/, label: '底模加载', role: '加载只用于图生视频的 checkpoint', category: '加载', widgets: ['ckpt_name'] },
  { match: /^(UNETLoader|UnetLoaderGGUF)$/, label: '扩散模型加载', role: '只加载 UNet / 扩散模型，不加载 CLIP 和 VAE', category: '加载', widgets: ['unet_name'] },
  { match: /^VAELoader$/, label: 'VAE 加载', role: '单独指定 VAE，用于编码和解码', category: '加载', widgets: ['vae_name'] },
  { match: /^(CLIPLoader|DualCLIPLoader|TripleCLIPLoader)$/, label: '文本编码器加载', role: '单独加载 CLIP 文本编码器', category: '加载', widgets: ['clip_name', 'clip_name1', 'clip_name2'] },
  { match: /^LoraLoader$/, label: 'LoRA 加载', role: '给模型和 CLIP 叠加 LoRA，模型与 CLIP 强度可分别设置', category: '加载', widgets: ['lora_name', 'strength_model', 'strength_clip'], lora: true },
  { match: /^LoraLoaderModelOnly$/, label: 'LoRA 加载（仅模型）', role: '只作用于 MODEL，不改变 CLIP', category: '加载', widgets: ['lora_name', 'strength_model'], lora: true },
  { match: /Lora/i, label: 'LoRA 加载', role: '第三方 LoRA 加载节点', category: '加载', lora: true },
  { match: /^ControlNetLoader$/, label: 'ControlNet 加载', role: '加载 ControlNet 模型，用于约束构图', category: '加载', widgets: ['control_net_name'] },
  { match: /^UpscaleModelLoader$/, label: '放大模型加载', role: '加载超分模型，用于放大图片', category: '加载', widgets: ['model_name'] },
  { match: /^CLIPVisionLoader$/, label: 'CLIP 视觉加载', role: '加载 CLIP Vision，用于参考图或风格迁移', category: '加载', widgets: ['clip_name'] },
  { match: /^StyleModelLoader$/, label: '风格模型加载', role: '加载风格模型', category: '加载', widgets: ['style_model_name'] },
  { match: /^LoadImage(Mask)?$/, label: '读取图片', role: '从磁盘读取图片或遮罩', category: '加载', widgets: ['image'] },

  // 采样
  { match: /^KSampler$/, label: '采样器', role: '按种子、步数、CFG 去噪生成，是出图的核心环节', category: '采样', widgets: ['seed', 'control_after_generate', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'] },
  { match: /^KSamplerAdvanced$/, label: '高级采样器', role: '可分段控制起止步数，常用于分阶段重绘', category: '采样', widgets: ['add_noise', 'noise_seed', 'control_after_generate', 'steps', 'cfg', 'sampler_name', 'scheduler', 'start_at_step', 'end_at_step', 'denoise'] },
  { match: /^(SamplerCustom|SamplerCustomAdvanced)$/, label: '自定义采样器', role: '把噪声、采样算法、调度器分开连接', category: '采样', widgets: [] },
  { match: /^RandomNoise$/, label: '噪声源', role: '生成初始噪声，决定种子', category: '采样', widgets: ['noise_seed'] },
  { match: /^KSamplerSelect$/, label: '采样算法', role: '选择采样算法（euler、dpmpp 等）', category: '采样', widgets: ['sampler_name'] },
  { match: /Scheduler$/, label: '调度器', role: '控制步数如何分配到去噪强度', category: '采样', widgets: ['steps', 'scheduler', 'denoise'] },
  { match: /^CFGGuider$|Guider$/, label: '引导器', role: '把正负条件合成引导信号', category: '采样', widgets: ['cfg'] },

  // 条件
  { match: /^CLIPTextEncode(SDXL)?$/, label: '文本编码', role: '把提示词编码成条件，正向和负向各一个', category: '条件', widgets: ['text'] },
  { match: /TextEncode|Text.*Encoder/i, label: '文本编码', role: '提示词编码节点', category: '条件', widgets: ['text'] },
  { match: /^ConditioningCombine$|^ConditioningConcat$/, label: '条件合并', role: '合并多组条件', category: '条件', widgets: [] },
  { match: /^ConditioningSetArea/, label: '条件分区', role: '限定条件作用的画面区域', category: '条件', widgets: [] },
  { match: /^ControlNetApply/, label: '应用 ControlNet', role: '把 ControlNet 约束加到条件上', category: '条件', widgets: ['strength'] },
  { match: /^FluxGuidance$/, label: 'Flux 引导', role: '设定 Flux 的引导强度', category: '条件', widgets: ['guidance'] },
  { match: /^ConditioningZeroOut$/, label: '条件清零', role: '产出空条件，常用于负向', category: '条件', widgets: [] },

  // 潜空间
  { match: /^Empty.*Latent|Latent.*Empty/, label: '空潜空间', role: '设定出图宽高与批次', category: '潜空间', widgets: ['width', 'height', 'batch_size'] },
  { match: /^VAEEncode$/, label: 'VAE 编码', role: '把图片编码进潜空间，图生图的入口', category: '潜空间', widgets: [] },
  { match: /^VAEDecode$/, label: 'VAE 解码', role: '把潜空间解码成图片', category: '潜空间', widgets: [] },
  { match: /^LatentUpscale/, label: '潜空间放大', role: '在潜空间里放大，再继续采样', category: '潜空间', widgets: [] },
  { match: /^LatentComposite/, label: '潜空间合成', role: '合并两块潜空间', category: '潜空间', widgets: [] },

  // 图像
  { match: /^SaveImage$/, label: '保存图片', role: '把图片写入 output 目录，文件名前缀在这里设置', category: '图像', widgets: ['filename_prefix'] },
  { match: /^PreviewImage$|^SaveAnimatedWEBP$/, label: '预览图片', role: '在界面预览，不落盘或输出动图', category: '图像', widgets: ['filename_prefix'] },
  { match: /^ImageScale(By)?$/, label: '图像缩放', role: '按尺寸或倍数缩放图片', category: '图像', widgets: ['upscale_method', 'width', 'height'] },
  { match: /^ImageUpscaleWithModel$/, label: '模型放大', role: '用超分模型放大图片', category: '图像', widgets: [] },
  { match: /^MaskToImage$|^ImageToMask$/, label: '遮罩转换', role: '遮罩与图片互转', category: '图像', widgets: [] },

  // 工具
  { match: /^(Note|MarkdownNote)$/, label: '备注', role: '画布上的说明文字，不参与计算', category: '工具', widgets: ['text'] },
  { match: /^Reroute$/, label: '转发点', role: '整理连线走向，不参与计算', category: '工具', widgets: [] },
  { match: /^PrimitiveNode$/, label: '数值', role: '提供共享的数值或文本', category: '工具', widgets: [] }
]

// Widget keys that hold model files, so a workflow's resources can be listed.
const MODEL_KEY = /(ckpt_name|checkpoint_name|unet_name|diffusion_model_name|^clip_name\d*$|vae_name|control_net_name|upscale_model_name|style_model_name|model_name)$/

const entry = type => CATALOG.find(row => row.match.test(type)) || null
const pretty = value => {
  if (typeof value !== 'object' || value === null) return String(value).length > 120 ? `${String(value).slice(0, 120)}…` : String(value)
  return Array.isArray(value) ? `${value.length} 项` : '…'
}

/** Node types plus their widget values, from a saved UI graph or an API graph. */
export function readNodes(workflow, prompt) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes.filter(node => node && typeof node === 'object') : []
  if (nodes.length) return expandNodes(workflow)
  // Images saved without a UI graph still carry the API graph.
  const graph = prompt && typeof prompt === 'object' && !Array.isArray(prompt) ? Object.entries(prompt) : []
  return graph
    .filter(([, node]) => node && typeof node === 'object' && node.class_type)
    .map(([id, node]) => ({
      type: String(node.class_type),
      title: typeof node._meta?.title === 'string' ? node._meta.title : '',
      values: Object.entries(node.inputs || {}).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).map(([, value]) => value),
      keys: Object.entries(node.inputs || {}).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).map(([key]) => key),
      group: '',
      id
    }))
}

/**
 * ComfyUI subgraphs are nodes whose `type` is the subgraph id; their real nodes live
 * in `definitions.subgraphs`. Flattening them is what makes LoRA detection work on
 * the workflows that pack everything into a subgraph.
 */
function expandNodes(workflow, depth = 0, group = '') {
  const subgraphs = new Map()
  for (const sub of workflow?.definitions?.subgraphs || []) if (sub?.id) subgraphs.set(String(sub.id), sub)
  const out = []
  for (const node of Array.isArray(workflow?.nodes) ? workflow.nodes : []) {
    if (!node || typeof node !== 'object') continue
    const type = String(node.type || '')
    const sub = subgraphs.get(type)
    if (sub && depth < 3) {
      const name = typeof sub.name === 'string' && sub.name && sub.name !== 'New Subgraph' ? sub.name : (typeof node.title === 'string' && node.title ? node.title : '子图')
      out.push(...expandNodes(sub, depth + 1, name))
      continue
    }
    out.push({
      type,
      title: typeof node.title === 'string' ? node.title : '',
      values: Array.isArray(node.widgets_values) ? node.widgets_values : node.widgets_values && typeof node.widgets_values === 'object' ? Object.values(node.widgets_values) : [],
      keys: null,
      group: sub ? '未能展开的子图' : group
    })
  }
  return out
}

/**
 * Explain every node, and pull out the model files and LoRA used.
 *
 * @returns {{nodes: Array, loras: Array, models: Object, categories: Array}}
 */
export function explainWorkflow(workflow, prompt) {
  const raw = readNodes(workflow, prompt)
  const models = { checkpoint: [], unet: [], clip: [], vae: [], other: [] }
  const loras = [], out = [], categories = new Map()
  for (const node of raw) {
    const known = entry(node.type)
    const widgetNames = known?.widgets || []
    const params = []
    node.values.forEach((value, index) => {
      let key = node.keys ? node.keys[index] : widgetNames[index]
      // Unknown LoRA plugins still follow the name-then-strengths widget order.
      if (!key && known?.lora) key = index === 0 ? 'lora_name' : index === 1 ? 'strength_model' : index === 2 ? 'strength_clip' : undefined
      if (!key || value === undefined || value === '' || typeof value === 'object') return
      if (params.length < 6) params.push([key, pretty(value)])
      if (typeof value !== 'string') return
      // A LoRA loader's name is the first widget in a UI graph, or the `lora_name` input in an API graph.
      if ((known?.lora && index === 0) || key === 'lora_name') {
        const pick = (name, offset) => {
          const at = node.keys ? node.keys.indexOf(name) : -1
          const found = at >= 0 ? node.values[at] : node.values[index + offset]
          return typeof found === 'number' ? found : undefined
        }
        loras.push({ name: value, type: node.type, label: known?.label || 'LoRA 加载', strengthModel: pick('strength_model', 1), strengthClip: pick('strength_clip', 2) })
        return
      }
      if (!MODEL_KEY.test(key)) return
      const bucket = /ckpt_name|checkpoint_name/.test(key) ? 'checkpoint'
        : /unet_name|diffusion_model_name/.test(key) ? 'unet'
          : /clip_name/.test(key) ? 'clip'
            : /vae_name/.test(key) ? 'vae' : 'other'
      if (!models[bucket].includes(value)) models[bucket].push(value)
    })
    const category = known?.category || '其它'
    categories.set(category, (categories.get(category) || 0) + 1)
    out.push({ type: node.type, title: node.title, label: known?.label || node.type, role: known?.role || '自定义或第三方节点', category, group: node.group || '', params })
  }
  const order = ['加载', '采样', '条件', '潜空间', '图像', '工具', '其它']
  return {
    nodes: out,
    loras,
    models,
    categories: [...categories.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))
  }
}
