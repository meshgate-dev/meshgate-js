---
"@meshgate/sdk": minor
---

Initial release of `@meshgate/sdk` (v0.1.0).

Implements the complete Meshgate HITL SDK for TypeScript/JavaScript:

- `MeshgateClient` with `guard()` — full yield-and-hydrate flow: serialize args → POST /v1/intent → allowed/blocked/gated handling, AES-256-GCM encryption with HKDF-SHA256 key derivation, SSE subscription, verify-token phone-home, tamper detection, fn() execution
- `reconcile()` — cold resume after process restart; scans storage adapter, resumes approved gates, cleans up expired/rejected/orphaned gates, re-subscribes pending gates
- `@guardrail` decorator — TypeScript 5.x standard method decorator wrapping `guard()`
- Storage adapters: `FileSystemAdapter` (Node.js default), `CloudflareKVAdapter` (Cloudflare Workers), `NoopAdapter` (testing)
- Split-knowledge security: local storage holds ciphertext only; `gateNonce` held by cloud, returned only on successful `POST /v1/verify-token`
- SSE streaming with exponential backoff polling fallback (1→2→4→8→16→30s cap)
- Full lifecycle hooks: `onGateExpired`, `onGateRejected`, `onGateOrphaned`, `onGateApproved`
- Works in Node.js ≥ 18, Cloudflare Workers, Vercel Edge, Deno, Bun — Web Crypto API only, no Node.js built-ins required
