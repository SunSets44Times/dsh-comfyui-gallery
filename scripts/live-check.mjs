import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const base = process.env.GALLERY_BASE || 'http://127.0.0.1:58351/comfyui-gallery/api/'
const output = process.argv[2] || 'work/live-validation.json'
const samples = []
for (let i = 0; i < 5; i++) {
  const t = performance.now()
  const res = await fetch(base + 'list?limit=60'); const data = await res.json()
  if (!res.ok) throw new Error(JSON.stringify(data))
  samples.push({ ms: Math.round((performance.now() - t) * 10) / 10, total: data.total })
}
// Use a neutral landscape fixture already present in the user's output folder.
const list = await (await fetch(base + 'list?limit=60&q=sword')).json()
const fallback = await (await fetch(base + 'list?limit=60&q=Krea2_Naiwa_3L')).json()
const candidates = [...list.items, ...fallback.items]
let chosen
for (const item of candidates) {
  const detail = await (await fetch(base + 'item?id=' + item.id)).json()
  if (detail.hasMetadata && detail.positive && !/explicit|nude|sex|breast|penis|vagina/i.test(detail.positive)) { chosen = detail; break }
}
if (!chosen) throw new Error('No neutral metadata fixture found')
const start = performance.now()
const response = await fetch(base + 'thumb?id=' + chosen.id)
const thumbnail = Buffer.from(await response.arrayBuffer())
const thumbnailMs = Math.round((performance.now() - start) * 10) / 10
if (response.status !== 200 || response.headers.get('content-type') !== 'image/webp') throw new Error(thumbnail.toString())
const head = await fetch(base + 'file?id=' + chosen.id, { method: 'HEAD' })
const raw = await fetch(base + 'raw?id=' + chosen.id + '&kind=prompt')
const prompt = await raw.json()
const prompts = Object.values(prompt).flatMap(n => Object.entries(n.inputs || {}).filter(([key, value]) => /text|prompt/.test(key) && typeof value === 'string').map(([, value]) => value))
const negativePrompts = Object.values(prompt).flatMap(n => Object.entries(n.inputs || {}).filter(([key, value]) => /negative_prompt/.test(key) && typeof value === 'string').map(([, value]) => value))
const report = { timestamp: new Date().toISOString(), health: await (await fetch(base + 'health')).json(), listSamples: samples,
  selected: { id: chosen.id, name: chosen.name, width: chosen.width, height: chosen.height, positiveCharacters: chosen.positive.length, negativeCharacters: chosen.negative.length, sampling: chosen.sampling, models: chosen.models, loraCount: chosen.loras.length, positiveMatchesRawNode: prompts.includes(chosen.positive), negativeMatchesRawNode: negativePrompts.includes(chosen.negative), rawExcludedFromDetail: !('rawWorkflow' in chosen) && !('rawPrompt' in chosen) },
  thumbnail: { ms: thumbnailMs, bytes: thumbnail.length, type: response.headers.get('content-type') }, imageHead: { status: head.status, length: head.headers.get('content-length'), type: head.headers.get('content-type') },
  invalidPathStatus: (await fetch(base + 'item?id=' + Buffer.from('C:\\Windows\\secret.png').toString('base64url'))).status,
  postStatus: (await fetch(base + 'refresh', { method: 'POST' })).status }
await fs.mkdir(path.dirname(output), { recursive: true })
await fs.writeFile(output, JSON.stringify(report, null, 2))
await fs.writeFile(path.join(path.dirname(output), 'verified-thumb.webp'), thumbnail)
console.log(JSON.stringify(report, null, 2))
