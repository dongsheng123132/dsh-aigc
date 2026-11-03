// 文生歌曲（Suno）：异步任务 —— 提交 → 轮询 → 下载
// 协议：POST /suno/submit/music  →  响应 data = 任务号
//       GET  /suno/fetch/<id>    →  每 10s 轮询，一次通常出 2 首（clips）
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { explainHttp } from './image.mjs'

function taskIdOf(p) {
  for (const c of [p?.task_id, p?.taskId, p?.id, p?.data, p?.data?.task_id, p?.data?.taskId,
    p?.data?.id, p?.data?.data?.task_id, p?.data?.data?.id]) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return ''
}

const OK_WORDS = /^(complete|completed|success|succeeded|finished|done)$/i
const BAD_WORDS = /^(fail|failed|error|cancelled|canceled|rejected)$/i

// 真实结构（2026-11-03 实测）：
// { code:"success", data:{ created_at, data:[ { audio_url, title, duration, status:"complete",
//   state:"succeeded", model_name:"chirp-hawk", major_model_version:"v6", clip_id, ... } ] } }
// 歌是在 data.data[] 里，状态是每个 clip 上的字段——不要再多套一层 data.data.data。
export function readTask(v) {
  const d = v?.data ?? v
  const list = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : []
  const first = list[0] || {}
  const statuses = [first.status, first.state, d?.status, d?.state, v?.status].filter((x) => typeof x === 'string')
  const codeOk = typeof v?.code === 'string' && OK_WORDS.test(v.code)
  const state = statuses.some((s) => BAD_WORDS.test(s)) ? 'failed'
    : list.length && (statuses.length === 0 || statuses.some((s) => OK_WORDS.test(s)) || codeOk) ? 'completed'
      : 'pending'
  const reason = first?.fail_reason || d?.fail_reason || d?.reason || d?.error || ''
  const progress = d?.progress || d?.data?.progress || ''
  return { state, clips: list, reason, progress, taskStatus: statuses[0] || (typeof v?.code === 'string' ? v.code : '') }
}

// mv: Suno 版本。生产实测在用 chirp-v5-5；更老的 chirp-v4 系列部分已下线。
export async function generateMusic({ baseUrl, apiKey, prompt, lyrics, tags, title, instrumental, mv, timeoutMs, downloadTimeoutMs, pollMs, maxPollMs, outputDir }) {
  const body = { prompt }
  if (lyrics) {
    body.lyrics = lyrics
    if (tags) body.tags = tags
    if (title) body.title = title
  } else {
    // chirp-hawk = Suno v6（实测服务端就解析成这个）
    body.mv = mv || 'chirp-hawk'
  }
  if (instrumental) body.make_instrumental = true

  const submit = await fetch(`${baseUrl}/suno/submit/music`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs ?? 60000)
  })
  const submitText = await submit.text()
  if (!submit.ok) throw new Error(explainHttp(submit.status, submitText))
  let submitJson
  try { submitJson = JSON.parse(submitText) } catch { throw new Error(`提交返回非 JSON：${submitText.slice(0, 200)}`) }
  const taskId = taskIdOf(submitJson)
  if (!taskId) throw new Error(`提交成功但没拿到任务号：${submitText.slice(0, 200)}`)

  const interval = pollMs ?? 10000
  const deadline = Date.now() + (maxPollMs ?? 600000)
  let last = { state: 'pending', clips: [], progress: '' }
  while (Date.now() < deadline) {
    await sleep(interval)
    const r = await fetch(`${baseUrl}/suno/fetch/${encodeURIComponent(taskId)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs ?? 30000)
    })
    const t = await r.text()
    if (!r.ok) {
      if (r.status >= 500) continue // 上游抖动，继续等
      throw new Error(explainHttp(r.status, t))
    }
    let v
    try { v = JSON.parse(t) } catch { continue }
    last = readTask(v)
    if (last.state === 'failed') throw new Error(`生成失败：${last.reason || last.taskStatus || '上游未给原因'}`)
    // 服务端刚把 status 置为 complete 时，clip 里可能还没有 audio_url（半成品）。
    // 只认"带音频地址"的完成，否则继续等到 deadline。
    if (last.state === 'completed' && last.clips.some((c) => c.audio_url || c.audioUrl || c.url)) break
  }
  if (last.state !== 'completed') throw new Error(`轮询超时（任务 ${taskId} 仍在生成，可稍后用同一任务号继续查询）`)
  // 服务端 status=complete 与"媒体可就绪"之间有时间差：立刻读到的 clip 可能缺 duration、
  // 或 audio_url 还不可下载（实测：同一任务几分钟后能正常下 4.5MB）。
  // 因此完成后一律重查一次拿全字段，再做下载。
  {
    await sleep(Math.min(interval, 3000))
    const rr = await fetch(`${baseUrl}/suno/fetch/${encodeURIComponent(taskId)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs ?? 30000)
    })
    if (rr.ok) {
      const again = readTask(await rr.json())
      if (again.clips.some((c) => c.audio_url || c.audioUrl || c.url)) last = again
    }
  }

  const clips = last.clips
  let files = []
  mkdirSync(outputDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i] || {}
    const url = c.audio_url || c.audioUrl || c.url || ''
    const item = { title: c.title || c.name || '', duration: c.duration ?? c.metadata?.duration ?? null, audioUrl: url }
    if (url) {
      // 媒体文件刚生成时可能短暂不可下载，退避重试；最终失败要把原因交回调用方，
      // 否则就是"扣了钱却静默无产物"。
      let lastErr = ''
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const rr = await fetch(url, { signal: AbortSignal.timeout(downloadTimeoutMs ?? 180000) })
          if (rr.ok) {
            const path = join(outputDir, `aigc-music-${stamp}-${i + 1}.mp3`)
            writeFileSync(path, Buffer.from(await rr.arrayBuffer()))
            item.path = path
            lastErr = ''
            break
          }
          lastErr = `HTTP ${rr.status}`
        } catch (e) {
          lastErr = e instanceof Error ? e.message : String(e)
        }
        if (attempt < 3) await sleep(4000)
      }
      if (!item.path && lastErr) item.downloadError = lastErr
    }
    files.push(item)
  }
  let merged = files
  // 最终补齐：再查一次任务，把 duration / title 补全（GET 不计费）
  try {
    const rr = await fetch(`${baseUrl}/suno/fetch/${encodeURIComponent(taskId)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs ?? 30000)
    })
    if (rr.ok) {
      const fin = readTask(await rr.json())
      if (fin.clips.length) merged = mergeClipMeta(files, fin.clips)
    }
  } catch { /* 补齐失败不影响主流程 */ }

  return { ok: merged.length > 0, taskId, count: merged.length, files: merged }
}

// 服务端的 duration 也是延迟填充的（实测：完成瞬间为空，几分钟后有值）。
// 下载完成后再查一次，把缺的字段补上。纯函数，便于离线回归。
export function mergeClipMeta(files, clips) {
  if (!Array.isArray(files) || !Array.isArray(clips)) return files
  return files.map((f, i) => {
    const c = clips[i] || {}
    return {
      ...f,
      title: f.title || c.title || '',
      duration: f.duration ?? c.duration ?? c.metadata?.duration ?? null
    }
  })
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
