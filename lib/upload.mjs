// 上传参考音频（Suno uploads）：把一段音频收进 Suno 账号，换回一个 clip_id，
// 后续可以做拼接（suno_concat）等后处理，也可作为后续「照这个风格再写一首」的素材。
//
// ⚠️ 只收【公网可访问】的音频 URL，不收本地文件。
// 网关侧 2026-11-09 实测：缺 url 会直接报 `url_empty`；传本地路径无效。
// 协议：POST /suno/submit/uploads { url } → task_id；GET /suno/fetch/<id> 轮询。
import { explainHttp } from './image.mjs'
import { readTask } from './music.mjs'

function taskIdOf(p) {
  for (const c of [p?.task_id, p?.taskId, p?.id, p?.data, p?.data?.task_id, p?.data?.taskId, p?.data?.id,
    p?.data?.data?.task_id, p?.data?.data?.id]) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return ''
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

export async function uploadAudio({ baseUrl, apiKey, url, timeoutMs, pollMs, maxPollMs }) {
  const target = String(url || '').trim()
  if (!target) {
    throw new Error('缺少音频地址。这个工具只接受【公网可访问】的音频 URL（http/https），不接受本地文件路径——先把文件放到能被外部访问的地方，再把链接填进来。')
  }
  if (!/^https?:\/\//i.test(target)) {
    throw new Error(`音频地址必须以 http:// 或 https:// 开头，收到的是「${target.slice(0, 80)}」。本地文件请先上传到任意图床/对象存储拿到公网链接。`)
  }

  const submit = await fetch(`${baseUrl}/suno/submit/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ url: target }),
    signal: AbortSignal.timeout(timeoutMs ?? 60000)
  })
  const submitText = await submit.text()
  if (!submit.ok) throw new Error(explainHttp(submit.status, submitText))
  let submitJson
  try { submitJson = JSON.parse(submitText) } catch { throw new Error(`提交返回非 JSON：${submitText.slice(0, 200)}`) }
  const taskId = taskIdOf(submitJson)
  if (!taskId) throw new Error(`提交成功但没拿到任务号：${submitText.slice(0, 200)}`)

  const interval = pollMs ?? 8000
  const deadline = Date.now() + (maxPollMs ?? 300000)
  let last = { state: 'pending', clips: [], progress: '' }
  while (Date.now() < deadline) {
    await sleep(interval)
    const r = await fetch(`${baseUrl}/suno/fetch/${encodeURIComponent(taskId)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs ?? 30000)
    })
    const t = await r.text()
    if (!r.ok) {
      if (r.status >= 500) continue
      throw new Error(explainHttp(r.status, t))
    }
    let v
    try { v = JSON.parse(t) } catch { continue }
    last = readTask(v)
    if (last.state === 'failed') throw new Error(`上传失败：${last.reason || last.taskStatus || '上游未给原因'}`)
    const clip = last.clips.find((c) => c && (c.clip_id || c.id))
    if (last.state === 'completed' && clip) {
      return {
        ok: true,
        taskId,
        clipId: clip.clip_id || clip.id || '',
        title: clip.title || clip.name || '',
        duration: clip.duration ?? clip.metadata?.duration ?? null,
        audioUrl: clip.audio_url || clip.audioUrl || '',
        imageUrl: clip.image_url || clip.imageUrl || '',
        note: '拿到 clipId 后可继续做后处理（如拼接 suno_concat）；原音频已进入 Suno 账号。'
      }
    }
  }
  throw new Error(`轮询超时（任务 ${taskId} 仍在处理，可稍后用同一任务号继续查询）`)
}
