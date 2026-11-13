import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { GalleryStore, encodeId } from '../lib/store.js'
import { Library } from '../lib/library.js'
import { Similarity } from '../lib/similarity.js'
import { Batches } from '../lib/batch.js'
import { Reuse } from '../lib/reuse.js'
import { createHandler } from '../lib/index.js'
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-features-')), root = path.join(fixture, 'images'), cacheDir = path.join(fixture, 'cache')
const python = process.env.GALLERY_PYTHON || 'D:/Program Files/Comfy UI/python/python.exe'
let checks = 0, store, library, similarity, batches, server
const check = (value, label) => { assert.ok(value, label); checks++ }
const rejects = async (fn, code) => { await assert.rejects(fn, e => e.status === code); checks++ }
const until = async fn => { for (let i = 0; i < 600; i++) { const v = fn(); if (v) return v; await sleep(50) }; throw new Error('test timeout') }
try {
  const made = spawnSync(python, ['scripts/features-fixture.py', root], { encoding: 'utf8', windowsHide: true }); assert.equal(made.status, 0, made.stderr)
  store = new GalleryStore({ roots: [root], cacheDir, python, warmCount: 0 }); await store.ready; await store.refresh()
  library = new Library(store); store.library = library; await library.ready
  similarity = new Similarity(store); batches = new Batches(store, null, library); const reuse = new Reuse(store)
  const id = encodeId(path.join(root, 'landscape.png')), other = encodeId(path.join(root, 'geometry.png')), copy = encodeId(path.join(root, 'landscape-copy.jpg'))
  await Promise.all([library.update(id, { favorite: true }), library.update(id, { rating: 4, tags: ['景色', '景色'], note: 'morning favorite' })])
  check(library.get(id).favorite && library.get(id).rating === 4 && library.get(id).tags.length === 1, 'serialized concurrent updates preserve fields')
  const reopened = new Library(store); await reopened.ready; check(reopened.get(id).note === 'morning favorite', 'annotations persist')
  for (const patch of [{ rating: 6 }, { rating: 2.5 }, { favorite: 1 }, { tags: [1] }, { note: 'x'.repeat(4001) }]) await rejects(() => library.update(id, patch), 400)
  await rejects(() => library.update(encodeId(path.join(fixture, 'outside.png')), { favorite: true }), 403)
  const saved = library.get(id); await library.startIndex(); await library.indexTask
  const facets = await library.facets(); check(facets.indexed === 3 && facets.models.includes('base.safetensors') && facets.loras.includes('detail.safetensors'), 'model and LoRA index')
  check((await store.list({ favorite: '1', rating: '4', tag: '景色', limit: 1 })).total === 1, 'annotation filtering before pagination')
  check((await store.list({ model: 'base.safetensors', lora: 'detail.safetensors' })).total === 2, 'model and LoRA filtering')
  check((await store.list({ q: 'morning favorite' })).items[0].id === id, 'notes searchable')
  await library.update(id, { text: 'mountain, sunrise', tags: ['mountain', 'sunrise'] }, true)
  check((await store.list({ q: 'sunrise', favorite: '1' })).total === 1, 'generated caption searchable')
  const captions = await library.captions([id, other]); check(captions.files.length === 1 && captions.skipped.length === 1 && captions.files[0].name === 'landscape.txt', 'caption export and skipped originals')
  await rejects(() => library.update(id, { expectedSignature: 'stale', text: 'wrong' }, true), 409)
  const draft = await reuse.prepare(id); check(draft.hasGraph && draft.fields.some(f => f.key === 'seed'), 'reuse extracts editable fields')
  const graph = await reuse.materialize({ draftId: draft.draftId, edits: [{ node: '4', key: 'seed', value: 456 }] })
  check(graph['4'].inputs.seed === 456 && graph['4'].inputs.model[0] === '3' && graph['5'].inputs.filename_prefix === 'test', 'reuse edits preserve connections and outputs')
  await rejects(() => reuse.materialize({ draftId: draft.draftId, edits: [{ node: '5', key: 'filename_prefix', value: 'changed' }] }), 400)
  await rejects(() => reuse.materialize({ draftId: draft.draftId, edits: [{ node: '4', key: 'seed', value: '456' }] }), 400)
  await rejects(() => reuse.materialize({ draftId: 'missing' }), 404)
  let calls = 0
  const execute = async args => { calls++; const file = JSON.parse(await fs.readFile(args.workflow_path)); check(args.action === 'run' && args.wait === false && file['4'].inputs.seed === 123, 'workbench uses saved graph path'); await sleep(20); return { success: true, prompt_id: 'mock-only', status: 'queued' } }
  const submission = reuse.submit({ draftId: draft.draftId }, execute); await sleep(5); await rejects(() => reuse.submit({ draftId: draft.draftId }, execute), 409); await submission; await reuse.submit({ draftId: draft.draftId }, execute); check(calls === 1, 'concurrent and repeated submission deduplicated without real generation')
  const large = await reuse.prepare(id); reuse.drafts.get(large.draftId).graph['4'].inputs.seed = '18446744073709551615'; await rejects(() => reuse.submit({ draftId: large.draftId }, execute), 400)
  const noGraph = await reuse.prepare(copy); check(!noGraph.hasGraph, 'metadata-free image has summary fallback')
  await rejects(() => reuse.materialize({ draftId: noGraph.draftId }), 400)
  let submitted = 0
  const fake = { token: 'test-token', tools: async () => ({ tools: [{ ready: true, models: [{ id: 'model' }] }] }), submit: async ({ id }) => { submitted++; return { jobId: 'fake-' + submitted, state: id === other ? 'error' : 'done', error: id === other ? 'fixture failure' : undefined, result: { text: 'batch mountain', tags: [{ tag: 'mountain' }] } } }, cancel: () => ({ state: 'cancelled' }) }
  batches.interrogator = fake
  const started = await batches.start({ ids: [id, other, id] }); check(started.total === 2 && !('task' in started), 'batch deduplicates and hides internal Promise'); await batches.jobs.get(started.id).task
  const completed = batches.status(started.id); check(completed.state === 'done' && completed.results.length === 1 && completed.errors.length === 1, 'batch keeps partial successes and errors')
  check(library.get(id).generated.text === 'batch mountain', 'batch caption persisted')
  await rejects(() => batches.start({ ids: [], model: 'model' }), 400)
  fake.submit = async () => ({ jobId: 'pending', state: 'running' }); fake.status = () => ({ jobId: 'pending', state: 'running' }); let cancels = 0; fake.cancel = () => { cancels++ }
  const running = await batches.start({ ids: [id, other] }); batches.cancel(running.id); await batches.jobs.get(running.id).task; check(batches.status(running.id).state === 'cancelled' && cancels > 0, 'batch cancellation prevents remaining inference')
  await similarity.start({ ids: [id, copy, other], mode: 'phash', level: 'normal' }); await similarity.task
  let result = similarity.view(); check(result.state === 'done' && result.groups.some(g => g.members.some(m => m.id === id) && g.members.some(m => m.id === copy)), 'real pHash groups resized JPEG with original')
  check(!result.groups.some(g => g.members.some(m => m.id === id) && g.members.some(m => m.id === other)), 'pHash separates unrelated geometry')
  check(Object.keys(similarity.records).length === 3, 'fingerprints cached')
  await similarity.start({ ids: [id, copy], mode: 'phash' }); await similarity.task; check(similarity.view().state === 'done', 'cached rerun completes')
  await rejects(() => similarity.start({ ids: [id], mode: 'bad' }), 400)
  server = http.createServer(createHandler(store, { count: async () => 0 }, fake, { library, batches, similarity, reuse })); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/comfyui-gallery/api/`
  const post = (route, body, token = 'test-token') => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gallery-token': token }, body: JSON.stringify(body) })
  check((await post('annotation', { id, patch: { favorite: true } }, '')).status === 403, 'mutations require token')
  check((await fetch(base + 'similarity/start', { method: 'HEAD' })).status === 405, 'HEAD never starts compute')
  check((await fetch(base + 'annotation?id=' + id)).status === 200, 'GET annotation is read-only')
  check((await post('annotation', { id, patch: { rating: 5 } })).status === 200, 'annotation API writes')
  check((await post('annotation', { id, patch: { note: 'x'.repeat(270000) } })).status === 413, 'bounded JSON body')
  check((await post('captions', { ids: [id] })).status === 200, 'caption API')
  check((await fetch(base + 'features')).status === 200, 'feature capabilities')
  const stat = await fs.stat(path.join(root, 'landscape.png')); await fs.utimes(path.join(root, 'landscape.png'), stat.atime, new Date(stat.mtimeMs + 2000)); await store.refresh()
  check((await library.captions([id])).files.length === 0, 'changed image invalidates generated tags')
  await rejects(() => reuse.materialize({ draftId: large.draftId }), 409)
  const corruptDir = path.join(fixture, 'corrupt'); await fs.mkdir(corruptDir); await fs.writeFile(path.join(corruptDir, 'library.json'), 'broken')
  const corrupt = new Library({ config: { cacheDir: corruptDir } }); await corrupt.ready; await rejects(() => corrupt.update(id, {}), 503); check(await fs.readFile(path.join(corruptDir, 'library.json'), 'utf8') === 'broken', 'corrupt annotations preserved')
  // Exercise the shipped client without screenshots or a browser build.
  let client, internal
  let source = await fs.readFile('lib/client.js', 'utf8')
  source = source.replace('exports.apply = apply', 'exports.__test = { captionZip, Compare, ReusePanel, BatchPanel, SimilarPanel, MarkEditor, Card, GalleryBody, Detail, Prompt, CopyButton, allPromptParameters }; exports.apply = apply')
  let clipboardText = ''
  let slots = [], cursor = 0, requests = []
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }), useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] }, useEffect: () => {}, useRef: v => ({ current: v }) }
  const mockFetch = async (url, options) => { requests.push({ url, body: options?.body && JSON.parse(options.body) }); return { ok: true, json: async () => ({ promptId: 'ui-mock', status: 'queued' }) } }
  vm.runInNewContext(source, { window: { isSecureContext: true, __ModuleLoader__: { load: m => { client = m.factory(() => react) } } }, navigator: { clipboard: { writeText: async value => { clipboardText = value } } }, fetch: mockFetch, URLSearchParams, Blob, TextEncoder, setTimeout, clearTimeout, console })
  internal = client.__test
  const zip = internal.captionZip([{ folder: 'image-1', name: '测试.txt', text: 'caption 内容' }]); await fs.writeFile(path.join(fixture, 'captions.zip'), Buffer.from(await zip.arrayBuffer()))
  const zipCheck = spawnSync(python, ['-c', "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert z.read('image-1/测试.txt').decode() == 'caption 内容'", path.join(fixture, 'captions.zip')], { encoding: 'utf8', windowsHide: true }); check(zipCheck.status === 0, 'client ZIP readable with UTF8 names and CRC')
  function render(name, props, initial) { if (initial) slots = initial; cursor = 0; return internal[name](props) }
  function nodes(tree) { return typeof tree === 'object' && tree ? [tree, ...(tree.children || []).flatMap(nodes)] : [] }
  for (const [component, props] of [['Compare', { ids: [id, copy] }], ['ReusePanel', { id, token: 'x' }], ['BatchPanel', { ids: [id], token: 'x' }], ['SimilarPanel', { ids: [id], features: { semantic: { ready: true } } }], ['MarkEditor', { id }], ['GalleryBody', {}], ['Card', { item: { id, name: 'fixture', mtime: Date.now() }, checked: true }]]) { check(render(component, props, []).type, 'client initial render ' + component) }
  const firstDetail = await store.detail(other), secondDetail = { ...firstDetail, id, sampling: { ...firstDetail.sampling, seed: 999 }, positive: 'different prompt' }
  const copyDetail = { ...secondDetail, positive: '风景\nmasterpiece', negative: '', sampling: { seed: '18446744073709551615', cfg: 0, denoise: 0, steps: 20 }, loras: [{ name: 'detail.safetensors', strength: 0, strengthClip: 0.7 }] }
  const detailTree = render('Detail', { item: copyDetail }, [])
  const positivePrompt = nodes(detailTree).find(node => node.type === internal.Prompt && node.props.label === '正向提示词')
  const promptTree = render('Prompt', positivePrompt.props, [])
  const copyActions = nodes(promptTree).find(node => node.props.className === 'cg-actions').children.filter(node => node && node.type === internal.CopyButton)
  check(copyActions.length === 2 && copyActions[0].props.value === copyDetail.positive, 'copy all sits beside the unchanged positive copy button')
  const allButton = render('CopyButton', copyActions[1].props, [])
  check(allButton.props['aria-label'] === '复制全部提示词和参数' && allButton.children[0].children[0] === '复制全部提示词和参数', 'copy all has a visible and accessible label')
  await allButton.props.onClick({ preventDefault() {}, stopPropagation() {} })
  check(clipboardText.startsWith('正向提示词：\n风景\nmasterpiece\n\n负向提示词：\n\n\n'), 'clipboard preserves multiline positive and intentional empty negative')
  const copiedParameters = JSON.parse(clipboardText.slice(clipboardText.indexOf('{')))
  check(copiedParameters['采样参数'].seed === copyDetail.sampling.seed && copiedParameters['采样参数'].cfg === 0 && copiedParameters['LoRA 与权重'][0].strength === 0 && copiedParameters['LoRA 与权重'][0].strengthClip === 0.7, 'copy preserves long seed and zero-valued parameters and LoRA weights')
  check(copiedParameters['图片尺寸'].width === copyDetail.width && JSON.stringify(copiedParameters['模型']) === JSON.stringify(copyDetail.models) && Array.isArray(copiedParameters['全部采样节点']), 'copy includes image dimensions models and all sampler branches')
  check(internal.allPromptParameters({}).includes('"采样参数": {}'), 'missing metadata copies without fabricated generation values')
  const comparison = render('Compare', { ids: [other, id] }, [[firstDetail, secondDetail], '', 2])
  check(nodes(comparison).filter(n => n.props.className === 'cg-difference').length >= 2, 'comparison highlights prompt and seed differences')
  const panes = nodes(comparison).filter(n => n.props.className === 'cg-zoom-pane'), paneA = { scrollLeft: 80, scrollTop: 60, scrollWidth: 500, clientWidth: 100, scrollHeight: 500, clientHeight: 200 }, paneB = { scrollLeft: 0, scrollTop: 0, scrollWidth: 900, clientWidth: 100, scrollHeight: 600, clientHeight: 300 }
  panes[0].props.ref(paneA); panes[1].props.ref(paneB); panes[0].props.onScroll({ currentTarget: paneA }); check(paneB.scrollLeft === 160 && paneB.scrollTop === 60, 'comparison synchronizes normalized pan positions')
  const reuseProps = { id: other, token: 'test-token' }, uiDraft = await reuse.prepare(other)
  let reuseTree = render('ReusePanel', reuseProps, [uiDraft, {}, '', false, null]), seedLabel = nodes(reuseTree).find(n => n.type === 'label' && String(n.children[0]).includes('seed'))
  seedLabel.children[1].props.onChange({ target: { value: '789' } }); reuseTree = render('ReusePanel', reuseProps)
  await nodes(reuseTree).find(n => n.type === 'button' && n.children[0] === '通过生成工作台提交').props.onClick()
  await until(() => slots[4])
  check(requests.at(-1).url.endsWith('reuse/submit') && requests.at(-1).body.edits.some(e => e.key === 'seed' && e.value === 789), 'reuse UI submits edited typed fields through existing route')
  reuseTree = render('ReusePanel', reuseProps); check(nodes(reuseTree).some(n => n.type === 'button' && n.children[0] === '已提交生成' && n.props.disabled), 'reuse UI prevents repeated generation clicks')
  let selections = 0, stars = 0
  const card = render('Card', { item: { id, name: 'fixture', mtime: Date.now() }, token: 'x', checked: false, toggle: () => selections++, favorite: () => stars++ }, [])
  nodes(card).find(n => n.type === 'input').props.onChange(); nodes(card).find(n => n.type === 'button' && n.children[0] === '☆').props.onClick()
  check(selections === 1 && stars === 1 && !nodes(card).some(n => n.type === 'button' && nodes(n).slice(1).some(c => c.type === 'button' || c.type === 'input')), 'card selection and favorite controls remain independent')
  const savedMark = { favorite: true, rating: 5, tags: 'foo, bar', note: 'note' }, markProps = { id, token: 'x', changed: () => {} }
  const markTree = render('MarkEditor', markProps, [savedMark, '', false])
  nodes(markTree).find(n => n.type === 'input' && n.props.value === 'foo, bar').props.onChange({ target: { value: 'foo, bar' } })
  await nodes(markTree).find(n => n.type === 'button').props.onClick()
  check(requests.at(-1).body.patch.tags.join(',') === 'foo,bar', 'mark UI normalizes tag input')
  reuse.close()
  console.log(JSON.stringify({ ok: true, checks, realGeneration: false, screenshots: false }))
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  await batches?.close(); await similarity?.close(); await library?.close(); await store?.close()
  await fs.rm(fixture, { recursive: true, force: true })
}
