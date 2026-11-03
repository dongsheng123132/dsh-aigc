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

function readTask(v) {
  const d = v?.data ?? v
  const statuses = [d?.data?.status, d?.status, d?.state, v?.status].filter((x) => typeof x === 'string')
  const state = statuses.some((s) => BAD_WORDS.test(s)) ? 'failed'
    : statuses.some((s) => OK_WORDS.test(s)) ? 'completed'
      : 'pending'
  const clips = d?.data?.clips || d?.clips || d?.data?.data || []
  const reason = d?.fail_reason || d?.reason || d?.error || ''
  const progress = d?.progress || d?.data?.progress || ''
  return { state, clips: Array.isArray(clips) ? clips : [], reason, progress, taskStatus: statuses[0] || '' }
}

export async function generateMusic({ baseUrl, apiKey, prompt, lyrics, tags, title, instrumental, timeoutMs, pollMs, maxPollMs, outputDir }) {
  const body = { prompt }
  if (lyrics) {
    body.lyrics = lyrics
    if (tags) body.tags = tags
    if (title) body.title = title
  } else {
    body.mv = 'chirp-v4'
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
    if (last.state === 'completed') break
    if (last.state === 'failed') throw new Error(`生成失败：${last.reason || last.taskStatus || '上游未给原因'}`)
  }
  if (last.state !== 'completed') throw new Error(`轮询超时（任务 ${taskId} 仍在生成，可稍后用同一任务号继续查询）`)

  const clips = last.clips
  const files = []
  mkdirSync(outputDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i] || {}
    const url = c.audio_url || c.audioUrl || c.url || ''
    const item = { title: c.title || c.name || '', duration: c.duration ?? null, audioUrl: url }
    if (url) {
      try {
        const rr = await fetch(url, { signal: AbortSignal.timeout(timeoutMs ?? 120000) })
        if (rr.ok) {
          const path = join(outputDir, `aigc-music-${stamp}-${i + 1}.mp3`)
          writeFileSync(path, Buffer.from(await rr.arrayBuffer()))
          item.path = path
        }
      } catch { /* 下载失败不致命：把 url 交回给模型 */ }
    }
    files.push(item)
  }
  return { ok: files.length > 0, taskId, count: files.length, files }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
