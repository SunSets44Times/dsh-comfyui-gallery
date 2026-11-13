// 目录树结构测试：buildTree 的节点、计数与过滤路径。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const base = (process.env.GALLERY_LIB || 'C:/Users/34721/Documents/Codex/2026-11-12/yued/work/gallery').replace(/\\/g, '/')
const lib = name => new URL(`lib/${name}`, `file:///${base}/`).href
const { GalleryStore, encodeId } = await import(lib('store.js'))

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-tree-'))
const cache = path.join(root, '.cache')
await fsp.mkdir(cache, { recursive: true })

const make = async rel => {
  const file = path.join(root, rel)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, PNG)
}
await make('projects/planrender/a.png')
await make('projects/planrender/b.png')
await make('projects/pfinal/c.png')
await make('scratch/2026-11/d.png')
await make('root.png')

const store = new GalleryStore({ roots: [root], cacheDir: cache })
await store.ready
await store.refresh()
const result = await store.list({ limit: 200 })

const check = (label, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra ? ' :: ' + extra : '')); if (!ok) process.exitCode = 1 }

const tree = result.tree || []
check('tree has one root node', tree.length === 1, String(tree.length))
const rootNode = tree[0]
check('root node counts every image', rootNode.count === 5, String(rootNode.count))
const names = rootNode.children.map(c => c.name).sort()
check('top level holds sub directories', JSON.stringify(names) === JSON.stringify(['projects', 'scratch']), JSON.stringify(names))

const projects = rootNode.children.find(c => c.name === 'projects')
check('projects counts its subtree', projects.count === 3, String(projects.count))
const planrender = projects.children.find(c => c.name === 'planrender')
check('leaf node counts its own files', planrender && planrender.count === 2, String(planrender && planrender.count))
check('node path is the rel-path filter value', planrender.path === path.join('projects', 'planrender'), planrender.path)

// 选中父节点时，前缀匹配把整棵子树带出来
const scoped = await store.list({ dir: path.join('projects'), limit: 200 })
check('parent path filters the whole subtree', scoped.total === 3, String(scoped.total))
const single = await store.list({ dir: path.join('projects', 'planrender'), limit: 200 })
check('leaf path filters one run', single.total === 2, String(single.total))

// 根目录散图不产生额外的 sub 节点
check('root-level image has empty sub', result.items.some(i => i.sub === ''), '')

// 日期范围下推到查询：三天前的图能一次跳到
const day = 86400000
const now = Date.now()
const touch = async (rel, offsetDays) => {
  const file = path.join(root, rel)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, PNG)
  const when = new Date(now - offsetDays * day)
  await fsp.utimes(file, when, when)
}
await touch('days/today.png', 0)
await touch('days/three.png', 3)
await touch('days/old.png', 40)
await store.refresh()

const threeAgo = new Date(now - 3 * day)
const dayStart = new Date(threeAgo.getFullYear(), threeAgo.getMonth(), threeAgo.getDate()).getTime()
const oneDay = await store.list({ from: dayStart, to: dayStart + day - 1, limit: 200 })
check('date range returns only that day', oneDay.total === 1 && oneDay.items[0].name === 'three.png', oneDay.total + ' ' + (oneDay.items[0] && oneDay.items[0].name))

const recent = await store.list({ from: now - 7 * day, limit: 200 })
check('from-only range excludes older images', recent.items.every(i => i.mtime >= now - 7 * day), String(recent.total))

const page = await store.list({ from: dayStart, to: dayStart + day - 1, limit: 60 })
check('range total is the range total, not the page size', page.total === 1 && page.items.length === 1)
await store.close()
await fsp.rm(root, { recursive: true, force: true })
console.log('done')
