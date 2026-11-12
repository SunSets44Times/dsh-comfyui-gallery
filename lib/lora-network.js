import https from 'node:https'

// No arbitrary URL proxy: only the metadata API and its image CDN are accepted.
export function allowedLoraUrl(value, kind = 'image') {
  let url
  try { url = new URL(value) } catch { throw new Error('预览地址格式错误') }
  const hosts = kind === 'json' ? ['civitai.com'] : ['image.civitai.com']
  if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.port && url.port !== '443' || url.username || url.password) throw new Error('仅支持 Civitai 官方资料与预览地址')
  if (kind === 'json' && !/^\/api\/v1\/(?:model-versions\/(?:by-hash\/[a-f0-9]{64}|[0-9]+)|models\/[0-9]+)$/.test(url.pathname)) throw new Error('模型资料地址格式错误')
  return url
}

export async function downloadLoraResource(value, kind, signal, redirects = 0) {
  const url = allowedLoraUrl(value, kind), maximum = kind === 'json' ? 8 * 1024 * 1024 : 20 * 1024 * 1024
  return new Promise((resolve, reject) => {
    const req = https.get(url, { signal, headers: { 'user-agent': 'DSH-ComfyUI-Gallery/0.8.0', accept: kind === 'json' ? 'application/json' : 'image/*' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume()
        if (redirects >= 3) return reject(new Error('预览重定向次数过多'))
        try { resolve(downloadLoraResource(new URL(res.headers.location, url).href, kind, signal, redirects + 1)) } catch (error) { reject(error) }
        return
      }
      if (res.statusCode !== 200) { res.resume(); reject(Object.assign(new Error(res.statusCode === 404 ? 'Civitai 未找到这个模型或预览' : `Civitai 请求失败（${res.statusCode}）`), { status: res.statusCode })); return }
      if (Number(res.headers['content-length']) > maximum) { res.destroy(); reject(new Error('资料或预览超过大小限制')); return }
      let size = 0, chunks = []
      res.on('data', chunk => { size += chunk.length; if (size > maximum) { res.destroy(new Error('资料或预览超过大小限制')); return }; chunks.push(chunk) })
      res.on('error', reject)
      res.on('end', () => resolve(Buffer.concat(chunks)))
    })
    const timer = setTimeout(() => req.destroy(new Error('资料获取超时，请稍后重试')), 30000)
    req.on('error', reject); req.on('close', () => clearTimeout(timer))
  })
}
