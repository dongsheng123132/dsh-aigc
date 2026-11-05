// 文生图 / 图生图：走 OpenAI 兼容的 /v1/images/generations
// 上游默认模型 gpt-image-2.6-1k（¥0.03/张，提示词要 GIF 时出 GIF89a）；中文提示词可用，写实/精细场景英文更稳。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SIZES = ['1024x1024', '1024x1536', '1536x1024', '1536x2048', '2048x1536', 'auto']

export function normalizeSize(size) {
  const s = (size || '').trim().toLowerCase()
  if (!s || s === 'auto') return 'auto'
  if (SIZES.includes(s)) return s
  // 容忍 "3:4" 这类比例写法 → 换算到最接近的档位，避免上游直接报错
  const ratio = s.match(/^(\d+)\s*[:/]\s*(\d+)$/)
  if (ratio) {
    const r = Number(ratio[1]) / Number(ratio[2])
    if (r > 1.25) return '1536x1024'
    if (r < 0.8) return '1024x1536'
    return '1024x1024'
  }
  return 'auto'
}

// 2.6-1k 在提示词写「生成 GIF 图」时返回 GIF89a；普通提示词仍是 PNG（也可能是 JPEG/WEBP）。
// 旧逻辑把文件名写死 .png，动图会躺成 .png —— 很多看图/发帖工具按扩展名判断，直接打不开。
function extOf(buf) {
  if (!buf || buf.length < 12) return ''
  const h = buf.subarray(0, 6).toString('latin1')
  if (h.startsWith('GIF8')) return '.gif'
  if (buf.subarray(0, 8).toString('latin1') === '\x89PNG\r\n\x1a\n') return '.png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg'
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp'
  return ''
}
const EXT_RE = /\.[A-Za-z0-9]{2,5}$/
function alignExt(p, ext) {
  if (!ext) return p
  return EXT_RE.test(p) ? p.replace(EXT_RE, ext) : p + ext
}

export async function generateImage({ baseUrl, apiKey, prompt, model, size, n, timeoutMs, outputDir }) {
  const body = {
    model: model || 'gpt-image-2.6-1k',
    prompt,
    n: Math.min(Math.max(Number(n) || 1, 1), 4),
    size: normalizeSize(size),
    response_format: 'b64_json'
  }
  const r = await fetch(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs ?? 180000)
  })
  const text = await r.text()
  if (!r.ok) {
    throw new Error(explainHttp(r.status, text))
  }
  let j
  try { j = JSON.parse(text) } catch { throw new Error(`上游返回非 JSON：${text.slice(0, 200)}`) }

  const items = Array.isArray(j?.data) ? j.data : Array.isArray(j?.images) ? j.images : []
  if (!items.length) throw new Error(`上游没有返回图片：${text.slice(0, 200)}`)

  mkdirSync(outputDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
  const files = []
  let format = ''
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {}
    let buf = null
    let sourceUrl
    if (it.b64_json) {
      buf = Buffer.from(it.b64_json, 'base64')
    } else if (it.url) {
      sourceUrl = it.url
      buf = await download(it.url, timeoutMs)
    }
    if (!buf) continue
    const path = alignExt(join(outputDir, `aigc-image-${stamp}-${i + 1}.png`), extOf(buf))
    writeFileSync(path, buf)
    const f = path.match(EXT_RE)
    if (!format && f) format = f[0].slice(1)
    files.push(sourceUrl ? { path, sourceUrl } : { path })
  }
  return { ok: files.length > 0, model: body.model, size: body.size, count: files.length, format: format || null, files }
}

async function download(url, timeoutMs) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs ?? 180000) })
  if (!r.ok) throw new Error(`下载图片失败：HTTP ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

// 余额不足/鉴权失败是最常见的两类，单独给出人话 + 充值入口
export function explainHttp(status, text) {
  const t = text || ''
  if (/quota|insufficient|余额|欠费/i.test(t)) return `余额不足（HTTP ${status}）。请先充值再重试。`
  if (/unauthorized|invalid.*(api[_\s-]*key|token)|401|403|鉴权|令牌/i.test(t)) return `凭证无效或已失效（HTTP ${status}）。换一把密钥或重新绑定设备钱包。`
  if (/model.*not.*found|无可用渠道|模型不存在/i.test(t)) return `模型不可用（HTTP ${status}）：${t.slice(0, 160)}`
  return `上游失败（HTTP ${status}）：${t.slice(0, 240)}`
}
