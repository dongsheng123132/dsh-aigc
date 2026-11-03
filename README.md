# dsh-aigc

**Give DeepSeek Harness a paintbrush: text-to-image and text-to-song generation from a single sentence.** Install free, pay per generation from a Xiapan Cloud device wallet.

Other plugins in this space give the agent *eyes* (`dsh-vision` and friends help you understand an image). This one gives it a *hand* — it produces image and audio files.

No API keys to register for, no subscription. The first call binds a wallet (balance 0), you top it up in WeChat, and every image or song spends that balance. The key *is* the wallet: keep it, and your money follows you to any machine.

## Tools

| Tool | What it does |
|---|---|
| `dsh_aigc_image` | Text-to-image. Returns local file paths. Accepts pixel sizes (`1024x1536`) or ratios (`3:4`, auto-mapped). |
| `dsh_aigc_music` | Text-to-song (vocals + lyrics) or instrumental. Async: submit → poll → download. Usually returns 2 variants. |
| `dsh_aigc_wallet` | `status` / `balance` / `adopt` (use a key from another machine) / `bind` (fresh empty wallet). |

## Install

```bash
dsh plugin --profile <name> add github:hfshfg/dsh-aigc
```

Then call any tool. On first use it binds a wallet and tells you the recharge link.

## Configuration (`cordis.yml`)

Every value below can be overridden; nothing is hard-coded.

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | env `UCLAW_API_BASE_URL` or `https://api.u-claw.org.cn` | API base |
| `payBaseUrl` | env `UCLAW_PAY_BASE_URL` or `https://u-claw.org.cn` | Recharge page base |
| `apiKey` | – | Pin a specific key instead of resolving one |
| `outputDir` | `~/Downloads/dsh-aigc` | Where images and audio land |
| `imageModel` | `gpt-image-2` | Image model id |
| `pollIntervalMs` | `10000` | Music task polling interval |
| `maxPollMs` | `600000` | Music polling ceiling |
| `imageTimeoutMs` | `180000` | Per-request timeout |

## Wallet rules (deliberate)

- **A key that the server rejects is never silently replaced.** If your key stops working, the tool asks you to `adopt` a valid one instead of binding a fresh empty wallet — otherwise your balance would be stranded.
- **Read-only validation only.** Liveness is checked against `/api/pricing`, which is not billed; a generation call is never used to "test" a key (a zero-balance key can never pass).
- **`bind` is explicit.** It creates a wallet with balance 0. Old balance stays on the server and can be recovered with the old key.
- **No hardware fingerprints.** Credentials are server-issued; a derived device id is not a credential.

## How this differs from neighbours

| Plugin | Does | Relationship |
|---|---|---|
| `dsh-vision` / `dsh-vision-toolkit` | Reads images into text models | Complementary: they let you see, this lets you make |
| `DSH OpenPencil` | Multi-page design canvas | Complementary: layout vs. asset generation |
| **This plugin** | **Generates** images and songs into local files | Currently the only generation plugin in this category |

## Known limitations

- **A funded wallet is required.** At zero or negative balance `/v1/*` answers `Invalid token` (not a broken key); top up and retry. The plugin never spends on your behalf and never silently swaps keys.
- **Models are upstream-owned.** No bundled model list; consult `/api/pricing`. Models can be retired without notice.
- **Music is asynchronous**, typically 1–5 minutes, polling capped at 10 minutes. A timed-out task can be re-queried with the same task id and is not charged twice.
- **Diffusion models still miss long Chinese text, QR codes and exact logos.** Generate the background, then set type separately.
- **No content moderation.** Responsibility for generated content rests with the caller.

## Models

Model ids change; the plugin does not keep a list. To see what your account can call:

```bash
GET {baseUrl}/api/pricing
```

At the time of writing that endpoint returned 179 models, including image (`gpt-image-2.5-sunburst`, `seedream-4-5`, `gemini-3-pro-image`, `wan2.7-image-pro`) and music (`suno_music`, `suno_concat`).

## Troubleshooting

| Symptom | Real cause | Fix |
|---|---|---|
| `/v1/*` returns `Invalid token` while `/api/pricing` returns 200 | Wallet balance is zero or negative — the token is rejected on metered endpoints | Top up, then retry |
| `余额不足` (quota) | Same, caught at generation time | Top up at the recharge link |
| Key genuinely rotated | Old key dies immediately; balance stays on the wallet | `adopt` the current key |
| Music task times out | Upstream still generating | Re-query later with the same task id |

## Layout

```
index.js            plugin entry: name / inject / apply, three tools
lib/wallet.mjs      key resolution, probe, bind, adopt, balance
lib/image.mjs       /v1/images/generations + size normalisation
lib/music.mjs       /suno/submit/music + /suno/fetch polling + download
```

## License

MIT
