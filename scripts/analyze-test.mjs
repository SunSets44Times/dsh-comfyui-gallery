import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../lib/store.js'
const value = spawnSync(process.env.GALLERY_PYTHON || loadConfig().python, [fileURLToPath(new URL('./analyze-test.py', import.meta.url))], { encoding: 'utf8', windowsHide: true })
if (value.status !== 0) { console.error(value.stderr || value.error?.message); process.exit(1) }
console.log(JSON.stringify({ ok: true, checks: 5, grouping: 'anchor, aspect ratio, resize, empty, semantic' }))
