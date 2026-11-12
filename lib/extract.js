/** Describe the executed API graph. UI metadata only supplements titles/groups. */
const SAMPLER = /^(KSampler|KSamplerAdvanced|SamplerCustom|SamplerCustomAdvanced)$/
const TEXT = /TextEncode|Text.*Encoder|CLIP.*Encode/i
const emptyModels = () => ({ checkpoint: [], unet: [], clip: [], vae: [], other: [] })
const link = value => Array.isArray(value) && value.length === 2 && Number.isInteger(value[1]) ? String(value[0]) : undefined
const unique = values => [...new Set(values.filter(Boolean))]

function ancestors(graph, id, seen = new Set()) {
  const pending = [id]
  while (pending.length && seen.size < 10000) {
    const current = pending.pop()
    if (!current || seen.has(current) || !graph[current]) continue
    seen.add(current)
    for (const value of Object.values(graph[current].inputs || {})) {
      const target = link(value)
      if (target) pending.push(target)
    }
  }
  return seen
}

function scalar(graph, value, seen = new Set()) {
  const id = link(value)
  if (id === undefined) return value
  if (seen.has(id) || seen.size > 32) return undefined
  seen.add(id)
  const inputs = graph[id]?.inputs || {}
  for (const key of ['value', 'text', 'string', 'int', 'float', 'seed', 'noise_seed']) {
    if (inputs[key] !== undefined) return scalar(graph, inputs[key], seen)
  }
  return undefined
}

function texts(graph, start, role = 'positive') {
  const result = [], seen = new Set()
  function walk(id, textSource = false) {
    if (!id || seen.has(id) || seen.size > 1000) return
    seen.add(id)
    const node = graph[id]
    if (!node) return
    if (/ConditioningZeroOut/.test(node.class_type || '')) return
    for (const [key, value] of Object.entries(node.inputs || {})) {
      if (/^(clip|model|vae|image|pixels|samples|latent_image)$/.test(key)) continue
      const target = link(value)
      let isText = /^(text|text_g|text_l|prompt|positive_prompt|negative_prompt|positive|negative|string|value)$/.test(key)
      const inputs = node.inputs || {}
      if (TEXT.test(node.class_type || '') && ('negative_prompt' in inputs || 'positive_prompt' in inputs)) {
        isText = role === 'negative' ? /^(negative_prompt|negative)$/.test(key) : /^(text|text_g|text_l|prompt|positive_prompt|positive)$/.test(key)
      }
      if (target && (!TEXT.test(node.class_type || '') || isText)) walk(target, isText)
      else if ((TEXT.test(node.class_type || '') && isText || textSource && isText) && typeof value === 'string') {
        if (value.trim()) result.push(value.trim())
      }
    }
  }
  walk(start)
  return unique(result).join('\n\n')
}

export function describeMetadata(prompt, workflow, dims = {}, filename = '') {
  const graph = prompt && typeof prompt === 'object' && !Array.isArray(prompt)
    ? Object.fromEntries(Object.entries(prompt).filter(([, node]) => node && typeof node === 'object' && node.class_type)) : {}
  const entries = Object.entries(graph)
  const groups = Array.isArray(workflow?.groups) ? workflow.groups.map(g => g?.title).filter(t => typeof t === 'string') : []
  const titleMap = new Map((Array.isArray(workflow?.nodes) ? workflow.nodes : []).map(n => [String(n.id), n.title]))
  const title = (id, node) => node._meta?.title || titleMap.get(id) || node.class_type
  const samplers = entries.filter(([, node]) => SAMPLER.test(node.class_type))
  const outputs = entries.filter(([, n]) => /SaveImage|PreviewImage|SaveAnimatedWEBP/i.test(n.class_type))
  const matching = outputs.filter(([, n]) => {
    const prefix = n.inputs?.filename_prefix
    const base = typeof prefix === 'string' ? prefix.split(/[\\/]/).pop() : ''
    return base && (filename.startsWith(base + '_') || filename.includes('-' + base + '_'))
  })
  const reachable = ancestors(graph, (matching[0] || outputs[outputs.length - 1])?.[0])
  // Prefer the final sampler connected to this image's output, not node-number order.
  const primary = [...samplers].reverse().find(([id]) => reachable.has(id)) || samplers[0]
  const scope = primary ? ancestors(graph, primary[0]) : new Set(entries.map(([id]) => id))
  const inputs = primary?.[1].inputs || {}
  const guider = graph[link(inputs.guider)]?.inputs || {}
  const positiveLink = link(inputs.positive ?? guider.positive ?? guider.conditioning)
  const negativeLink = link(inputs.negative ?? guider.negative)
  let positive = positiveLink ? texts(graph, positiveLink, 'positive') : ''
  let negative = negativeLink ? texts(graph, negativeLink, 'negative') : ''
  // An explicitly linked empty negative is intentional; never guess another branch.
  if (!positiveLink && !negativeLink) {
    const textNodes = entries.filter(([id, n]) => scope.has(id) && TEXT.test(n.class_type))
    const neg = textNodes.filter(([id, n]) => /negative|负向|负面/i.test(title(id, n)))
    negative = unique(neg.map(([id]) => texts(graph, id, 'negative'))).join('\n\n')
    positive = unique(textNodes.filter(([id]) => !neg.some(([nid]) => nid === id)).map(([id]) => texts(graph, id))).join('\n\n')
  }
  const models = emptyModels(), loras = []
  const modelScope = reachable.size ? reachable : scope
  for (const [id, node] of entries) {
    if (!modelScope.has(id)) continue
    const ins = node.inputs || {}
    for (const [key, val] of Object.entries(ins)) {
      if (typeof val !== 'string' || !val) continue
      if (key === 'lora_name') {
        loras.push({ node: id, title: title(id, node), name: val, strength: scalar(graph, ins.strength_model ?? ins.strength), strengthClip: scalar(graph, ins.strength_clip) })
        continue
      }
      let bucket
      if (/^(ckpt_name|checkpoint_name)$/.test(key)) bucket = 'checkpoint'
      else if (/^(unet_name|diffusion_model_name)$/.test(key)) bucket = 'unet'
      else if (/^(clip_name\d*|t5xxl)$/.test(key)) bucket = 'clip'
      else if (key === 'vae_name') bucket = 'vae'
      else if (/^(control_net_name|ipadapter.*|style_model_name|upscale_model_name|model_name)$/.test(key)) bucket = 'other'
      if (bucket && !models[bucket].includes(val)) models[bucket].push(val)
    }
  }
  const chains = samplers.map(([id, node]) => {
    const ins = node.inputs || {}, branch = ancestors(graph, id)
    const find = pattern => entries.find(([nid, n]) => branch.has(nid) && pattern.test(n.class_type))?.[1].inputs || {}
    const noise = find(/^RandomNoise$/), schedule = find(/Scheduler$/), select = find(/^KSamplerSelect$/), guidance = find(/Guider$/)
    return {
      node: id, type: node.class_type, title: title(id, node),
      seed: scalar(graph, ins.seed ?? ins.noise_seed ?? noise.noise_seed),
      steps: scalar(graph, ins.steps ?? schedule.steps), cfg: scalar(graph, ins.cfg ?? ins.guidance ?? guidance.cfg),
      samplerName: scalar(graph, ins.sampler_name ?? select.sampler_name), scheduler: scalar(graph, ins.scheduler ?? schedule.scheduler),
      denoise: scalar(graph, ins.denoise ?? schedule.denoise), startAt: scalar(graph, ins.start_at_step), endAt: scalar(graph, ins.end_at_step)
    }
  })
  const latentIds = [...ancestors(graph, link(inputs.latent_image))]
  const latent = latentIds.map(id => graph[id]).find(n => /Empty.*Latent|Latent.*Empty/.test(n.class_type) && n.inputs?.width !== undefined)
  const sizeNote = { width: scalar(graph, latent?.inputs.width) ?? dims.width, height: scalar(graph, latent?.inputs.height) ?? dims.height, batch: scalar(graph, latent?.inputs.batch_size) }
  return {
    hasMetadata: entries.length > 0, positive, negative, models, loras,
    sampling: chains.find(c => c.node === primary?.[0]), samplingChains: chains, sizeNote,
    nodes: entries.map(([id, node]) => ({ id, type: node.class_type, title: title(id, node),
      values: Object.entries(node.inputs || {}).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 6).map(([k, v]) => `${k}=${String(v).slice(0, 90)}`) })), groups
  }
}

export function excerpt(text, max = 160) {
  const flat = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
