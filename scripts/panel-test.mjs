import assert from 'node:assert/strict'
import fs from 'node:fs'

/**
 * Structure test for the workflow panel without a browser.
 *
 * The panel is a plain function component, so it can be rendered with stub hooks and
 * inspected as an element tree. This exists because the detail aside once sat *inside*
 * the list section, and `.cg-selected .cg-browser{display:none}` then hid the detail
 * and its "返回" button together — a bug a syntax check can never catch.
 */
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const start = source.indexOf('function WorkflowPanel(props) {')
assert.ok(start > 0, 'WorkflowPanel is found in client.js')
let depth = 0, end = -1
for (let i = source.indexOf('{', start); i < source.length; i++) {
  if (source[i] === '{') depth++
  else if (source[i] === '}' && --depth === 0) { end = i + 1; break }
}
const body = source.slice(start, end)

let checks = 0
const check = (value, label) => { assert.ok(value, label); checks++ }
const equal = (a, b, label) => { assert.equal(a, b, label); checks++ }

const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) })
const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const child of node.children || []) walk(child, visit)
}
const findAll = (tree, predicate) => { const out = []; walk(tree, node => { if (predicate(node)) out.push(node) }) ; return out }
const find = (tree, predicate) => findAll(tree, predicate)[0]
const label = node => typeof node === 'string' ? node : node && typeof node === 'object' ? (node.children || []).map(label).join('') : ''

function render(seed) {
  let cursor = 0
  const useState = initial => [cursor in seed ? seed[cursor++] : (cursor++, initial), function () {}]
  const factory = new Function('h', 'useState', 'useEffect', 'useRef', 'request', 'endpoint', 'copy', 'bytes', 'date', 'text', 'CopyButton', 'props',
    `${body}\nreturn WorkflowPanel(props)`)
  return factory(
    h, useState, function () {}, value => ({ current: value }),
    async () => ({}), (name) => `/api/${name}`, async () => {},
    value => `${value} B`, value => String(value), value => value === undefined || value === null ? '—' : String(value),
    function CopyButton() { return h('span', null, '复制') },
    { token: 'test-token', open() {} }
  )
}

const detail = {
  id: 'f.demo', kind: 'file', name: '人像工作流', title: '', path: 'D:/wf/demo.json',
  mtime: 1, size: 2048, nodeCount: 3, imageCount: 2, example: 'img1',
  graph: {
    nodes: [{ type: 'KSampler', title: '', label: '采样器', role: '按种子、步数、CFG 去噪生成', category: '采样', group: '', params: [['steps', '24']] }],
    loras: [{ name: 'detail.safetensors', label: 'LoRA 加载', strengthModel: 0.8, strengthClip: 0.6 }],
    models: { checkpoint: ['sd15.safetensors'], unet: [], clip: [], vae: [], other: [] },
    categories: [{ name: '采样', count: 1 }]
  },
  images: []
}
// useState order inside WorkflowPanel: query, sort, list, error, selected, detail, busy, message
const listState = { total: 1, saved: 1, unsaved: 0, roots: ['D:/wf'], indexed: 2, totalImages: 2, scanning: false, items: [{ id: 'f.demo', kind: 'file', name: '人像工作流', nodeCount: 3, loraCount: 1, imageCount: 2, mtime: 1, mtimeImage: 1, example: 'img1' }] }

// --- nothing selected: the list must own the whole width, no empty pane ----------
const idle = render(['', 'count', listState, '', '', null, false, ''])
const idleLayout = find(idle, node => String(node.props?.className || '').includes('cg-layout'))
check(idleLayout, 'layout container renders')
equal(idleLayout.props.className, 'cg-layout', 'no cg-selected class when nothing is selected')
equal(idleLayout.children.length, 1, 'only the list section renders when nothing is selected')
equal(findAll(idle, node => node.type === 'aside').length, 0, 'no empty detail pane is left behind')

// --- selected: detail must be a sibling of the list, and must carry a way back ----
const open = render(['', 'count', listState, '', 'f.demo', detail, false, ''])
const layout = find(open, node => String(node.props?.className || '').includes('cg-layout'))
check(layout, 'layout container renders')
equal(layout.props.className, 'cg-layout cg-selected', 'selection toggles the cg-selected class')
equal(layout.children.length, 2, 'layout holds exactly the list and the detail')
equal(layout.children[0].type, 'section', 'first child is the list section')
equal(layout.children[1].type, 'aside', 'detail is a sibling of the list, not nested inside it')
check(!find(layout.children[0], node => node.type === 'aside'), 'detail is not nested in the section that gets hidden')

const aside = layout.children[1]
equal(aside.props.className, 'cg-detail', 'detail keeps the cg-detail class')
const back = find(aside, node => node.type === 'button' && label(node).includes('返回'))
check(back, 'detail has a 返回 button')
check(find(aside, node => String(node.props?.className || '').includes('cg-detail-nav')), '返回 button sits in a visible nav bar')

// --- the explanation sections are rendered from the graph ------------------------
check(label(aside).includes('模型与 LoRA'), 'model and LoRA section renders')
check(label(aside).includes('节点解读'), 'node explanation section renders')
check(label(aside).includes('detail.safetensors'), 'LoRA file name renders')
check(label(aside).includes('采样器'), 'node label renders')
check(label(aside).includes('0.8'), 'LoRA strength renders')

console.log(`panel test: ${checks} checks passed`)
