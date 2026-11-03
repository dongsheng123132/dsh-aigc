// 文生图 / 图生图：走 OpenAI 兼容的 /v1/images/generations
// 上游默认模型 gpt-image-2；中文提示词可用，写实/精细场景英文更稳。
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

export async function generateImage({ baseUrl, apiKey, prompt, model, size, n, timeoutMs, outputDir }) {
  const body = {
    model: model || 'gpt-image-2',
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
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {}
    const path = join(outputDir, `aigc-image-${stamp}-${i + 1}.png`)
    if (it.b64_json) {
      writeFileSync(path, Buffer.from(it.b64_json, 'base64'))
      files.push({ path })
    } else if (it.url) {
      const buf = await download(it.url, timeoutMs)
      writeFileSync(path, buf)
      files.push({ path, sourceUrl: it.url })
    }
  }
  return { ok: files.length > 0, model: body.model, size: body.size, count: files.length, files }
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
