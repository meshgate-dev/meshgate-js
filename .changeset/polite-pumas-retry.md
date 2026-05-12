---
"@meshgate/sdk": patch
---

Harden SDK failure handling for guarded calls and edge runtimes.

- Retry intent registration and token verification on retryable 5xx responses, and honor `Retry-After` for 429 responses.
- Prevent polling fallback from leaving guarded calls pending forever when approval status checks return terminal auth or not-found errors.
- Return a clear `MeshgateConfigError` when the default filesystem storage adapter is used in edge runtimes.
