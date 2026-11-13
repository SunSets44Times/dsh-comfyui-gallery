import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import fs from 'node:fs'

const PLUGIN_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0' } catch { return '0.0.0' }
})()

// No arbitrary URL proxy: only the metadata API and its image CDN are accepted.
// 校验失败带 400 状态，避免被批量抓取误判成网络故障而中止整个队列。
const invalid = message => Object.assign(new Error(message), { status: 400 })

export function allowedLoraUrl(value, kind = 'image') {
  let url
  try { url = new URL(value) } catch { throw invalid('预览地址格式错误') }
  // 资料接口只认 civitai.com；预览图分布在 image./blobs./blobs-b2. 等多个 CDN 子域。
  const hostOk = kind === 'json' ? url.hostname === 'civitai.com' : /(^|\.)civitai\.com$/.test(url.hostname)
  if (url.protocol !== 'https:' || !hostOk || url.port && url.port !== '443' || url.username || url.password) throw invalid('仅支持 Civitai 官方资料与预览地址（收到 ' + url.hostname + '）')
  if (kind === 'json' && !/^\/api\/v1\/(?:model-versions\/(?:by-hash\/[a-f0-9]{64}|[0-9]+)|models\/[0-9]+)$/.test(url.pathname)) throw invalid('模型资料地址格式错误')
  return url
}

// 国内网络通常无法直连 Civitai，这里支持通过环境变量里的 HTTP 代理走 CONNECT 隧道。
// 只在显式配置代理时启用，未配置则保持原来的直连行为。
function proxyConfig() {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:') return null
    return {
      hostname: url.hostname,
      port: Number(url.port) || 80,
      auth: url.username ? 'Basic ' + Buffer.from(decodeURIComponent(url.username) + ':' + decodeURIComponent(url.password)).toString('base64') : undefined
    }
  } catch { return null }
}

function openTunnel(target, proxy, signal) {
  return new Promise((resolve, reject) => {
    const options = {
      host: proxy.hostname,
      port: proxy.port,
      method: 'CONNECT',
      path: target.hostname + ':443'
    }
    if (proxy.auth) options.headers = { 'proxy-authorization': proxy.auth }
    if (signal) options.signal = signal
    const req = http.request(options)
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error('代理隧道建立失败（' + res.statusCode + '）')); return }
      // 在回调内立即完成 TLS 握手：延迟到 await 之后会导致 socket 上残留非 TLS 数据。
      const secure = tls.connect({ socket, servername: target.hostname }, () => resolve(secure))
      secure.once('error', reject)
    })
    req.once('error', reject)
    req.end()
  })
}

async function get(url, headers, signal) {
  const proxy = proxyConfig()
  if (!proxy) return https.get(url, { signal, headers })
  // CONNECT 拿到的是裸 socket，必须自己完成 TLS 握手后再交给 https.request。
  const secure = await openTunnel(url, proxy, signal)
  // https.request 即使拿到已加密的 socket 也会自己再握手一次，这里交给
  // 自定义 agent 直接返回现成的 TLS 连接。
  const agent = new https.Agent({ keepAlive: false })
  agent.createConnection = (options, callback) => callback(null, secure)
  const req = https.request({
    hostname: url.hostname,
    port: 443,
    path: url.pathname + url.search,
    method: 'GET',
    headers,
    signal,
    agent
  })
  req.end()
  return req
}

// 代理在连续请求下偶发 TLS 断连，这类错误重试几次即可恢复，不必整批中止。
const RETRIABLE = /TLS|ECONNRESET|socket|ETIMEDOUT|EAI_AGAIN|EPIPE/i

export async function downloadLoraResource(value, kind, signal, redirects = 0, attempt = 0, apiKey = '') {
  const url = allowedLoraUrl(value, kind), maximum = kind === 'json' ? 8 * 1024 * 1024 : 20 * 1024 * 1024
  const headers = { 'user-agent': 'DSH-ComfyUI-Gallery/' + PLUGIN_VERSION, accept: kind === 'json' ? 'application/json' : 'image/*' }
  // Civitai API Key：提高限流额度，并能读取登录账号可见的模型资料。
  const token = apiKey || process.env.CIVITAI_API_KEY || ''
  if (token && url.hostname === 'civitai.com') headers.authorization = 'Bearer ' + token
  try {
    const req = await get(url, headers, signal)
    return await new Promise((resolve, reject) => {
      req.once('response', res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume()
          if (redirects >= 3) return reject(new Error('预览重定向次数过多'))
          try { resolve(downloadLoraResource(new URL(res.headers.location, url).href, kind, signal, redirects + 1, 0, apiKey)) } catch (error) { reject(error) }
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
      req.on('error', reject)
      req.on('close', () => clearTimeout(timer))
    })
  } catch (error) {
    if (attempt < 2 && !signal?.aborted && RETRIABLE.test(String(error.message))) {
      await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)))
      return downloadLoraResource(value, kind, signal, redirects, attempt + 1, apiKey)
    }
    throw error
  }
}
