// dsh-aigc —— 装免费，按次扣虾盘云钱包余额
// 插件形态：命名插件（name / inject / apply），无默认导出；工具注册在 ctx.tools 上
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createWallet } from './lib/wallet.mjs'
import { generateImage } from './lib/image.mjs'
import { generateMusic } from './lib/music.mjs'

export const name = 'hfshfg-aigc'
export const inject = ['tools']

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function fail(error, wallet) {
  const message = error instanceof Error ? error.message : String(error)
  const s = wallet.status()
  // 实测：余额透支时 /v1/* 会返回 "Invalid token"，容易误判成密钥坏了。
  // 所以 401 一律先让人查余额，再谈换密钥。
  const hint = /余额不足/.test(message)
    ? `充值后重试：${s.rechargeUrl || '（未绑定钱包）'}`
    : /凭证无效|401|403/.test(message)
      ? '先跑 dsh_aigc_wallet（action=balance）看余额：余额为 0 或负数时，/v1 会报 Invalid token，充值即可；余额正常才说明密钥失效，用 action=adopt 换一把。'
      : undefined
  return { ok: false, error: message, ...(hint ? { hint } : {}) }
}

export function createDefinitions(ctx, config = {}) {
  const wallet = createWallet(config)
  const outputDir = config.outputDir || join(homedir(), 'Downloads', 'dsh-aigc')

  const ensureReady = async () => {
    const s = await wallet.ensureKey()
    return s
  }

  return [
    defineTool({
      name: 'dsh_aigc_image',
      description:
        'Generate images from a text prompt. Install is free; each image spends Xiapan Cloud wallet balance. Returns local file paths. ' +
        'Write a full professional prompt (subject + detail/material + style + lighting + composition + quality words) instead of passing the user\'s raw sentence.',
      parameters: {
        prompt: { type: 'string', required: true, description: 'Full image prompt. Chinese works; English is steadier for photorealistic detail.' },
        size: { type: 'string', description: 'Pixels like 1024x1024, 1024x1536, 1536x1024; ratio strings such as 3:4 are mapped; default auto.' },
        model: { type: 'string', description: 'Image model id; default from config (gpt-image-2).' },
        n: { type: 'number', description: 'How many images, 1-4 (default 1).' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args) {
        try {
          const s = await ensureReady()
          const r = await generateImage({
            baseUrl: wallet.baseUrl,
            apiKey: s.apiKey,
            prompt: args.prompt,
            model: args.model || config.imageModel,
            size: args.size,
            n: args.n,
            timeoutMs: config.imageTimeoutMs,
            outputDir
          })
          return { ...r, outputDir }
        } catch (error) {
          return fail(error, wallet)
        }
      }
    }),

    defineTool({
      name: 'dsh_aigc_music',
      description:
        'Generate a song (with vocals and lyrics) or instrumental track from a prompt. Asynchronous: submits, polls until done, then downloads audio. ' +
        'Install is free; each song spends Xiapan Cloud wallet balance. Usually returns 2 variants.',
      parameters: {
        prompt: { type: 'string', required: true, description: 'Song description, or style direction when lyrics are supplied.' },
        lyrics: { type: 'string', description: 'Full lyrics with structure tags like [Verse]/[Chorus]; omit to let the model write them.' },
        tags: { type: 'string', description: 'Style tags when supplying lyrics, e.g. "pop, female vocal".' },
        title: { type: 'string', description: 'Track title when supplying lyrics.' },
        instrumental: { type: 'boolean', description: 'true for instrumental only (no vocals).' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args) {
        try {
          const s = await ensureReady()
          const r = await generateMusic({
            baseUrl: wallet.baseUrl,
            apiKey: s.apiKey,
            prompt: args.prompt,
            lyrics: args.lyrics,
            tags: args.tags,
            title: args.title,
            instrumental: args.instrumental,
            pollMs: config.pollIntervalMs,
            maxPollMs: config.maxPollMs,
            outputDir
          })
          return { ...r, outputDir }
        } catch (error) {
          return fail(error, wallet)
        }
      }
    }),

    defineTool({
      name: 'dsh_aigc_wallet',
      description:
        'Inspect the Xiapan Cloud device wallet used by the AIGC tools: binding status, masked key, balance and recharge link. ' +
        'Action "adopt" binds an existing key from another machine (balance follows the wallet).',
      parameters: {
        action: { type: 'string', enum: ['status', 'balance', 'adopt', 'bind'], description: 'status (default) | balance (read-only usage) | adopt (use an existing key) | bind (create a fresh empty wallet).' },
        apiKey: { type: 'string', description: 'Only for action=adopt: the sk-… key to use (its wallet balance comes with it).' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args) {
        const action = args.action || 'status'
        try {
          if (action === 'bind') {
            const b = await wallet.bindFresh()
            const st = wallet.status()
            return { ok: true, bound: true, walletId: b.walletId || '', status: st, rechargeUrl: st.rechargeUrl,
              warning: '已绑定全新钱包，余额为 0。旧钱包余额仍在服务端，可用旧密钥 adopt 找回。' }
          }
          if (action === 'adopt') {
            if (!args.apiKey || !String(args.apiKey).trim()) {
              const s = wallet.status()
              return { ok: false, error: 'action=adopt 需要提供 apiKey', current: s }
            }
            wallet.adopt(String(args.apiKey).trim())
            const st = wallet.status()
            const bal = await wallet.balance(st === null ? '' : (await wallet.ensureKey()).apiKey)
            return { ok: true, adopted: true, status: st, balance: bal, rechargeUrl: st.rechargeUrl }
          }
          const s = await wallet.ensureKey()
          const status = wallet.status()
          if (action === 'status') {
            return { ok: true, status, note: 'key 就是钱包，请自行备份；换机用 adopt 填入同一把钥匙，余额会跟过来。' }
          }
          const bal = await wallet.balance(s.apiKey)
          return { ok: true, status, balance: bal, rechargeUrl: status.rechargeUrl, unit: 'token（¥1 ≈ 50 万 token）' }
        } catch (error) {
          return fail(error, wallet)
        }
      }
    })
  ]
}

export function apply(ctx, config = {}) {
  for (const definition of createDefinitions(ctx, config)) ctx.tools.register(definition)
}
