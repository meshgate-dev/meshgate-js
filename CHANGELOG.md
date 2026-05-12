# @meshgate/sdk

## 0.2.2

### Patch Changes

- c363033: Harden SDK failure handling for guarded calls and edge runtimes.
  - Retry intent registration and token verification on retryable 5xx responses, and honor `Retry-After` for 429 responses.
  - Prevent polling fallback from leaving guarded calls pending forever when approval status checks return terminal auth or not-found errors.
  - Return a clear `MeshgateConfigError` when the default filesystem storage adapter is used in edge runtimes.

## 0.2.1

### Patch Changes

- 2836649: Fix SseClient silently dropping all events when server omits named "event:" SSE lines. Fall back to the "type" field embedded in the JSON data payload so guard() no longer hangs indefinitely against servers that embed the event type in the data body instead of the SSE event line.

## 0.2.0

### Minor Changes

- a1f7348: v2.3 SDK Polish: pending verify tracking (token_exhausted_on_retry), decryption failure handling in reconcile, FileSystemAdapter file locking, configurable sseReconnectDelays, structured logger with logLevel, reconcile ordering, guard awaits reconcile ready.

## 0.1.0

### Minor Changes

- 929ddee: Initial release of `@meshgate/sdk` (v0.1.0).

  Implements the complete Meshgate HITL SDK for TypeScript/JavaScript:
  - `MeshgateClient` with `guard()` — full yield-and-hydrate flow: serialize args → POST /v1/intent → allowed/blocked/gated handling, AES-256-GCM encryption with HKDF-SHA256 key derivation, SSE subscription, verify-token phone-home, tamper detection, fn() execution
  - `reconcile()` — cold resume after process restart; scans storage adapter, resumes approved gates, cleans up expired/rejected/orphaned gates, re-subscribes pending gates
  - `@guardrail` decorator — TypeScript 5.x standard method decorator wrapping `guard()`
  - Storage adapters: `FileSystemAdapter` (Node.js default), `CloudflareKVAdapter` (Cloudflare Workers), `NoopAdapter` (testing)
  - Split-knowledge security: local storage holds ciphertext only; `gateNonce` held by cloud, returned only on successful `POST /v1/verify-token`
  - SSE streaming with exponential backoff polling fallback (1→2→4→8→16→30s cap)
  - Full lifecycle hooks: `onGateExpired`, `onGateRejected`, `onGateOrphaned`, `onGateApproved`
  - Works in Node.js ≥ 18, Cloudflare Workers, Vercel Edge, Deno, Bun — Web Crypto API only, no Node.js built-ins required
