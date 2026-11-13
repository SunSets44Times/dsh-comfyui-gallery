// Delete-feature test. Point GALLERY_LIB at a plugin tree to test that copy.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const base = (process.env.GALLERY_LIB || 'C:/Users/34721/Documents/Codex/2026-11-12/yued/work/gallery').replace(/\\/g, '/')
const lib = name => new URL(`lib/${name}`, `file:///${base}/`).href
const { GalleryStore, encodeId } = await import(lib('store.js'))

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-del-'))
const cache = path.join(root, '.cache')
await fsp.mkdir(cache, { recursive: true })

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

const make = async (name, withJson) => {
  await fsp.writeFile(path.join(root, name), PNG)
  if (withJson) await fsp.writeFile(path.join(root, name.replace(/\.png$/, '.json')), JSON.stringify({ prompt: '{}' }))
}

await make('a.png', true)
await make('b.png', false)
await make('pair.png', true)
await make('pair.jpg', false)
await fsp.mkdir(path.join(root, 'sub'), { recursive: true })
await fsp.writeFile(path.join(root, 'sub', 'deep.png'), PNG)

const store = new GalleryStore({ roots: [root], cacheDir: cache })
await store.ready
await store.refresh()
console.log('indexed:', store.entries.size)

const check = (label, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) process.exitCode = 1 }

const a = await store.remove(encodeId(path.join(root, 'a.png')))
check('a.png unlinked', !fs.existsSync(path.join(root, 'a.png')))
check('a.json unlinked', !fs.existsSync(path.join(root, 'a.json')))
check('remove reports both files', a.removed.length === 2)
check('index entry dropped', !store.entries.has(path.join(root, 'a.png')))

await store.remove(encodeId(path.join(root, 'b.png')))
check('b.png unlinked', !fs.existsSync(path.join(root, 'b.png')))

await store.remove(encodeId(path.join(root, 'pair.png')))
check('pair.png unlinked', !fs.existsSync(path.join(root, 'pair.png')))
check('pair.json kept while pair.jpg exists', fs.existsSync(path.join(root, 'pair.json')))

await store.remove(encodeId(path.join(root, 'sub', 'deep.png')))
check('nested file unlinked', !fs.existsSync(path.join(root, 'sub', 'deep.png')))

const outside = path.join(os.tmpdir(), 'outside-gallery.png')
await fsp.writeFile(outside, PNG)
let blocked = false
try { await store.remove(encodeId(outside)) } catch (error) { blocked = error.status === 403 }
check('refuses ids outside gallery roots', blocked)
check('outside file untouched', fs.existsSync(outside))

let missing = false
try { await store.remove(encodeId(path.join(root, 'ghost.png'))) } catch (error) { missing = error.status === 404 }
check('missing file reports 404', missing)

let badId = false
try { await store.remove('NOPE') } catch (error) { badId = error.status === 400 }
check('malformed id reports 400', badId)

await store.flush()
const saved = JSON.parse(await fsp.readFile(path.join(cache, 'index.json'), 'utf8'))
check('index.json no longer lists deleted images', saved.items.every(item => !item.path.includes('a.png') && !item.path.includes('pair.png')))
console.log('index items:', saved.items.map(i => path.basename(i.path)))

await store.close()
await fsp.rm(outside, { force: true })
await fsp.rm(root, { recursive: true, force: true })
console.log('done')
