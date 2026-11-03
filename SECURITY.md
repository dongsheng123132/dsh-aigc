# Security

This plugin stores a wallet credential locally at `~/.dsh/aigc-wallet.json` (or reuses `~/.uking/device.json`).

- No credential is ever written into this repository, its build output, or its logs.
- The credential is a bearer token for a metered API. Treat it like cash: back it up, never commit it.
- Report vulnerabilities privately via GitHub security advisories rather than public issues.
