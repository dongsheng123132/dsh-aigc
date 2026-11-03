// 设备钱包：凭证由服务端签发，余额记在钱包上，不记在凭证上。
// 契约见 device-wallet 技能：C1 首启不抛 / C2 只读验证 / C3 不猜未知状态 / C4 单一真相源 / C5 换 key 要同步 / C6 存储取舍写进注释
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const STATE_PATH = join(homedir(), '.dsh', 'aigc-wallet.json')
const UKING_DEVICE = join(homedir(), '.uking', 'device.json')

// C1：连读写存储都要保护——目录不可写、U 盘拔掉、文件被锁都会抛
function readState() {
  try {
    if (!existsSync(STATE_PATH)) return {}
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    // C6：读坏了当成"还没绑定"（代价是可能重绑一个空钱包，所以界面必须有 adopt）
    return {}
  }
}

function writeState(state) {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true })
    const tmp = `${STATE_PATH}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, STATE_PATH) // 原子写，半截写坏不会污染真源
    return true
  } catch {
    return false
  }
}

function ukingKey() {
  try {
    if (!existsSync(UKING_DEVICE)) return ''
    const d = JSON.parse(readFileSync(UKING_DEVICE, 'utf8'))
    return typeof d?.key === 'string' && d.key.startsWith('sk-') ? d.key : ''
  } catch {
    return ''
  }
}

function normalizeBase(url, fallback) {
  const v = (url || fallback || '').trim()
  return v.replace(/\/+$/, '')
}

export function walletPaths() {
  return { statePath: STATE_PATH, ukingDevice: UKING_DEVICE }
}

export function createWallet(config = {}) {
  const baseUrl = normalizeBase(config.baseUrl || process.env.UCLAW_API_BASE_URL, 'https://api.u-claw.org.cn')
  const payBaseUrl = normalizeBase(config.payBaseUrl || process.env.UCLAW_PAY_BASE_URL, 'https://u-claw.org.cn')

  // 单一真相源：这一轮解析出来的 key 只在这里存一份
  let cached = null

  function resolveSync() {
    // 优先级：显式配置 > 环境变量 > 本插件状态 > U-King 设备文件
    if (config.apiKey) return { apiKey: config.apiKey, walletId: readState().walletId || '', source: 'config' }
    if (process.env.XIAPAN_API_KEY) return { apiKey: process.env.XIAPAN_API_KEY, walletId: readState().walletId || '', source: 'env' }
    const st = readState()
    if (st.apiKey) return { apiKey: st.apiKey, walletId: st.walletId || '', source: 'wallet' }
    const uk = ukingKey()
    if (uk) return { apiKey: uk, walletId: '', source: 'uking' }
    return { apiKey: '', walletId: '', source: 'none' }
  }

  async function bind() {
    const r = await fetch(`${baseUrl}/device/bind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(config.timeoutMs ?? 15000)
    })
    if (!r.ok) throw new Error(`bind failed: HTTP ${r.status}`)
    const j = await r.json()
    const apiKey = j?.key || j?.data?.key || j?.apiKey || ''
    const walletId = j?.walletId || j?.data?.walletId || ''
    if (!apiKey) throw new Error('bind 返回里没有 key')
    writeState({ apiKey, walletId })
    return { apiKey, walletId, source: 'bind' }
  }

  // C2：只读验证，不消耗额度
  async function balance(apiKey) {
    const r = await fetch(`${baseUrl}/api/usage/token/`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(config.timeoutMs ?? 15000)
    })
    const text = await r.text()
    if (!r.ok) return { ok: false, status: r.status, raw: text.slice(0, 300) }
    try {
      const j = JSON.parse(text)
      const d = j?.data ?? j
      return {
        ok: true,
        totalAvailable: d?.total_available ?? null,
        totalUsed: d?.total_used ?? null,
        totalGranted: d?.total_granted ?? null,
        unlimited: d?.unlimited_quota === true
      }
    } catch {
      return { ok: false, status: r.status, raw: text.slice(0, 300) }
    }
  }

  // C2：只读校验，不消耗额度。用 /api/pricing（免计费）判断凭证是否被服务端接受。
  // rotate 之后旧 key 会立刻失效，但余额仍挂在钱包上——所以失效时必须引导 adopt，
  // 绝不能悄悄 bind 一个新的空钱包（那等于把旧余额甩掉）。
  async function probe(apiKey) {
    try {
      const r = await fetch(`${baseUrl}/api/pricing`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(config.timeoutMs ?? 15000)
      })
      return { valid: r.ok, status: r.status }
    } catch (e) {
      return { valid: false, status: 0, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async function ensureKey() {
    if (cached?.apiKey) return cached
    const s = resolveSync()

    if (s.apiKey) {
      const p = await probe(s.apiKey)
      if (p.valid) {
        cached = s
        return s
      }
      // 有 key 但服务端不认：提示换一把，而不是重绑空钱包
      throw new Error(
        `凭证已失效（HTTP ${p.status}）：当前来源 ${s.source} 的密钥不再被接受。` +
        ' 请用 hfshfg_aigc_wallet 的 adopt 填入当前有效密钥（余额会跟过来）；' +
        ' 如果确认没有旧余额要保留，再显式 bind 新钱包。'
      )
    }

    // 完全没 key 才 bind（新钱包余额 0）
    const bound = await bind()
    if (config.bindWalletId) writeState({ apiKey: bound.apiKey, walletId: config.bindWalletId })
    cached = bound
    return bound
  }

  function rechargeUrl(apiKey) {
    return `${payBaseUrl}/recharge?key=${encodeURIComponent(apiKey)}`
  }

  // 换一把：只改本插件的凭证；旧 key 立刻失效、余额不受影响（钱记在钱包上）
  function adopt(apiKey, walletId = '') {
    const st = readState()
    writeState({ ...st, apiKey, walletId })
    cached = { apiKey, walletId, source: 'adopt' }
    return cached
  }

  function status() {
    const s = cached || resolveSync()
    return {
      bound: Boolean(s.apiKey),
      source: s.source,
      walletId: s.walletId || '',
      keyPreview: s.apiKey ? `${s.apiKey.slice(0, 6)}…${s.apiKey.slice(-4)}` : '',
      rechargeUrl: s.apiKey ? rechargeUrl(s.apiKey) : '',
      statePath: STATE_PATH
    }
  }

  // 显式绑定一个全新钱包（余额 0）。只有用户明确要放弃旧余额时才应调用。
  async function bindFresh() {
    const b = await bind()
    cached = b
    return b
  }

  return { baseUrl, payBaseUrl, ensureKey, balance, rechargeUrl, adopt, bindFresh, probe, status }
}
