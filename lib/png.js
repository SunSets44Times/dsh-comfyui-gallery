/**
 * Minimal PNG text-chunk reader.
 *
 * ComfyUI stamps two metadata blobs into every PNG it saves, as tEXt/iTXt chunks
 * placed before the image data:
 *   - `prompt`   the API-format graph (node id -> { class_type, inputs, _meta })
 *   - `workflow` the UI-format graph (nodes, links, widgets_values, groups)
 *
 * Only the chunk headers up to the first IDAT are read, so this never inflates the
 * pixel stream. No dependency, no image library.
 */
import fs from 'node:fs'
import zlib from 'node:zlib'

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const MAX_CHUNK = 16 * 1024 * 1024
const MAX_SCAN = 64 * 1024 * 1024

function decodeKeywordAndText(type, data, out) {
  if (data.length < 3) return
  const zero = data.indexOf(0)
  if (zero <= 0) return
  const keyword = data.toString('latin1', 0, zero)
  const rest = data.subarray(zero + 1)
  try {
    if (type === 'tEXt') {
      // ComfyUI writes UTF-8 JSON through PIL; latin1 would mangle non-ASCII prompts.
      out[keyword] = rest.toString('utf8')
      return
    }
    if (type === 'zTXt') {
      if (rest[0] !== 0) return
      out[keyword] = zlib.inflateSync(rest.subarray(1), { maxOutputLength: MAX_CHUNK }).toString('utf8')
      return
    }
    if (type === 'iTXt') {
      // keyword \0 compressionFlag(1) compressionMethod(1) languageTag \0 translatedKeyword \0 text
      if (rest.length < 3) return
      if (rest[0] > 1 || rest[1] !== 0) return
      const compressed = rest[0] === 1
      let cursor = 2
      const langEnd = rest.indexOf(0, cursor)
      if (langEnd < 0) return
      cursor = langEnd + 1
      const transEnd = rest.indexOf(0, cursor)
      if (transEnd < 0) return
      cursor = transEnd + 1
      const body = rest.subarray(cursor)
      out[keyword] = compressed ? zlib.inflateSync(body, { maxOutputLength: MAX_CHUNK }).toString('utf8') : body.toString('utf8')
    }
  } catch {
    /* a corrupt or exotic chunk is not worth failing the whole read */
  }
}

/**
 * Read the text chunks of a PNG.
 *
 * @param {string} filePath absolute path
 * @returns {Record<string,string>|null} keyword -> text, or null when the file is not a PNG
 */
export function readPngInfo(filePath) {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const signature = Buffer.alloc(8)
    if (fs.readSync(fd, signature, 0, 8, 0) < 8) return null
    if (!signature.equals(SIGNATURE)) return null
    const out = Object.create(null)
    let width, height
    let offset = 8
    const header = Buffer.alloc(8)
    while (offset < MAX_SCAN) {
      if (fs.readSync(fd, header, 0, 8, offset) < 8) break
      const length = header.readUInt32BE(0)
      const type = header.toString('latin1', 4, 8)
      if (type === 'IDAT' || type === 'IEND') break
      if (type === 'IHDR' && length === 13) {
        const data = Buffer.alloc(13)
        if (fs.readSync(fd, data, 0, 13, offset + 8) === 13) {
          width = data.readUInt32BE(0)
          height = data.readUInt32BE(4)
        }
      }
      if ((type === 'tEXt' || type === 'iTXt' || type === 'zTXt') && length > 0 && length <= MAX_CHUNK) {
        const data = Buffer.alloc(length)
        if (fs.readSync(fd, data, 0, length, offset + 8) === length) {
          decodeKeywordAndText(type, data, out)
        }
      }
      offset += 12 + length
      if (length > MAX_CHUNK) break
    }
    return { text: out, width, height }
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

export function readPngTextChunks(filePath) {
  return readPngInfo(filePath)?.text ?? null
}

/** Parse JSON without throwing. */
export function safeJson(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined
  try {
    // ComfyUI seeds can exceed Number.MAX_SAFE_INTEGER. Preserve those tokens as
    // strings, while skipping quoted JSON strings (including escaped quotes).
    const exact = text.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
      if (token[0] === '"' || /[.eE]/.test(token)) return token
      return Number.isSafeInteger(Number(token)) ? token : JSON.stringify(token)
    })
    return JSON.parse(exact)
  } catch {
    return undefined
  }
}
