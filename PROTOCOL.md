# Meshgate Wire Protocol — SDK Implementer Reference

**Version:** v2.2
**Status:** Stable (locked in production)
**Audience:** SDK implementers building Meshgate clients in Python, Go, Ruby, or other languages.

This document is the authoritative reference for building a Meshgate SDK in any language. Every HTTP request shape, response shape, event format, encryption scheme, and behavioral contract is described here in sufficient detail to implement a conforming SDK without reading TypeScript source.

---

## Table of Contents

1. [Overview — The Yield/Hydrate Flow](#1-overview--the-yieldhydrate-flow)
2. [Authentication](#2-authentication)
3. [Base URL and Versioning](#3-base-url-and-versioning)
4. [POST /v1/intent — Gate Registration](#4-post-v1intent--gate-registration)
5. [GET /v1/events/stream — SSE Subscription](#5-get-v1eventsstream--sse-subscription)
6. [GET /v1/approvals/:id/status — Polling Fallback](#6-get-v1approvalsidstatus--polling-fallback)
7. [POST /v1/verify-token — Atomic Phone-Home](#7-post-v1verify-token--atomic-phone-home)
8. [Encryption Scheme](#8-encryption-scheme)
9. [Storage Format](#9-storage-format)
10. [Retry and Failure Contracts](#10-retry-and-failure-contracts)
11. [Full Flow Walkthrough](#11-full-flow-walkthrough)
12. [Cold Resume — reconcile() Flow](#12-cold-resume--reconcile-flow)
13. [Behavioral Invariants](#13-behavioral-invariants)
14. [Error Reference](#14-error-reference)

---

## 1. Overview — The Yield/Hydrate Flow

The Meshgate SDK implements an **interceptor-based Human-in-the-Loop (HITL)** pattern. A function call is intercepted at the `guard()` boundary, suspended pending human authorization, and resumed only after cryptographic verification.

```
Developer calls: await gatedFn(arg1, arg2)
                         │
                         ▼
            [guard() intercepts the call]
                         │
                POST /v1/intent ──────────► Cloud evaluates policy
                         │
            ┌────────────┼────────────────┐
            │            │                │
         200 allowed   403 blocked      201 gated
            │            │                │
         call fn()    throw Blocked     encrypt args
                                        store locally
                                        subscribe SSE
                                           │
                            [human approves in dashboard]
                                           │
                            SSE: approval.approved
                                           │
                            POST /v1/verify-token ──► cloud burns token
                                           │
                                         200
                                           │
                            re-derive key via gateNonce
                            decrypt local ciphertext
                            verify payloadHash
                                           │
                                       call fn()
                                       clean up
                                       return result
```

**Key security property:** The SDK never calls `fn()` without a successful `POST /v1/verify-token` response. SSE events and polling results are signals only — they initiate the phone-home call, they do not authorize execution.

---

## 2. Authentication

All API calls include:

```
Authorization: Bearer {apiKey}
```

The API key is an agent key with the format `mg_live_...` or `mg_test_...`.

**Required scopes:**

- `sdk:write` — for `POST /v1/intent`
- `sdk:read` — for `GET /v1/approvals/:id/status`, `POST /v1/verify-token`, and `GET /v1/events/stream`

If the key is missing or the wrong scope is presented, the cloud returns `401` or `403`.

---

## 3. Base URL and Versioning

```
Default base URL: https://api.meshgate.dev
API version prefix: /v1
```

Full example: `POST https://api.meshgate.dev/v1/intent`

The base URL is configurable by the SDK consumer. All relative paths below are relative to the base URL.

All request and response bodies are `Content-Type: application/json`. All timestamps are ISO-8601 strings (e.g., `"2026-04-08T14:00:00.000Z"`). All binary values (keys, nonces, hashes) are base64 or base64url-encoded strings as specified per field.

---

## 4. POST /v1/intent — Gate Registration

**Purpose:** Register a function execution intent for policy evaluation.
**Scope required:** `sdk:write`
**Timeout per attempt:** 10 seconds
**Retryable:** Yes (503 and network errors — see §10)

### Request

```
POST /v1/intent
Authorization: Bearer {apiKey}
Content-Type: application/json
```

```json
{
  "intent": "process_refund",
  "intentArgs": {
    "customerId": "cust_123",
    "amount": 750
  },
  "payloadHash": "ejv7gfOD9pQzrW6QDTWz4jhVk/dqe3q1nUNVuLpB7iU=",
  "gateNonce": "dGVzdG5vbmNlX3ZhbHVlXzMyYnl0ZXNfYmFzZTY0dXJs",
  "expiresInSeconds": 86400,
  "description": "Refund $750 for customer cust_123"
}
```

**Field specifications:**

| Field              | Type    | Required | Description                                                                                                                                                                          |
| ------------------ | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `intent`           | string  | yes      | Intent name for policy lookup. No whitespace. Max 128 chars.                                                                                                                         |
| `intentArgs`       | object  | no       | Flat record for policy parameter evaluation. All values must be `string \| number \| boolean`. No nested objects, no arrays, no null. Omit or send `{}` for intent-name-only policy. |
| `payloadHash`      | string  | yes      | `base64(SHA-256(JSON.stringify(args)))` where `args` is the exact array of arguments. See §8.3.                                                                                      |
| `gateNonce`        | string  | yes      | 32 cryptographically random bytes, base64url-encoded. Generated by SDK before this call. Stored by cloud; returned on verify-token. See §8.1.                                        |
| `expiresInSeconds` | integer | no       | Gate TTL in seconds. Range: 60–604800. Overrides tenant/agent/intent settings if present.                                                                                            |
| `description`      | string  | no       | Human-readable context shown in the approval dashboard. Max 1000 chars.                                                                                                              |

### Responses

#### 200 OK — Allowed

Policy immediately allows the intent. Call `fn()` now. No storage written, no SSE needed.

```json
{
  "outcome": "allowed",
  "intent": "process_refund",
  "matchedPolicy": { "id": "pol_abc", "rule": "amount_below_threshold" }
}
```

#### 201 Created — Gated

Policy requires human approval. Enter the gate flow (encrypt, store, subscribe SSE).

```json
{
  "outcome": "gated",
  "approvalId": "app_01jdx8wq4dj2k",
  "intent": "process_refund",
  "expiresAt": "2026-04-08T14:00:00.000Z"
}
```

Store `approvalId` as the key. Use `expiresAt` for local expiry checks in `reconcile()`.

#### 403 Forbidden — Blocked

```json
{
  "outcome": "blocked",
  "error": "intent_blocked",
  "intent": "process_refund",
  "matchedPolicy": { "id": "pol_xyz", "rule": "require_manager_approval_above_500" }
}
```

Throw `MeshgateBlockedError`. Do not call `fn()`.

#### Other error responses

| Status | `error` field      | SDK action                                          |
| ------ | ------------------ | --------------------------------------------------- |
| `400`  | `agent_not_found`  | Throw `MeshgateConfigError`                         |
| `401`  | `unauthorized`     | Throw `MeshgateAuthError`                           |
| `403`  | `intent_blocked`   | Throw `MeshgateBlockedError`                        |
| `422`  | `validation_error` | Throw `MeshgateError` (SDK bug — malformed request) |
| `429`  | —                  | Retry after `Retry-After` header seconds            |
| `503`  | —                  | Retryable (see §10.1)                               |

---

## 5. GET /v1/events/stream — SSE Subscription

**Purpose:** Receive real-time approval lifecycle events.
**Scope required:** `sdk:read`
**Protocol:** Server-Sent Events (SSE) over persistent HTTP connection

### Request

```
GET /v1/events/stream?eventTypes=approval.approved,approval.rejected,approval.expired
Authorization: Bearer {apiKey}
Accept: text/event-stream
```

No request body. `eventTypes` is optional for compatibility, but SDKs should
request the terminal approval events they understand instead of subscribing to
the full tenant stream.

### Wire Format

Standard SSE wire format:

```
data: {"type":"approval.approved","entityId":"app_01jdx8wq4dj2k","payload":{"token":"tkn_xyz789abc"}}\n
\n
data: {"type":"approval.rejected","entityId":"app_01jdx8wq4dj2k","payload":{}}\n
\n
```

Each event is a single `data:` line containing a JSON object, followed by a blank line (`\n\n`).

### Event Schema

```json
{
  "type": "approval.approved",
  "entityId": "app_01jdx8wq4dj2k",
  "payload": { ... }
}
```

| Field      | Type   | Description                             |
| ---------- | ------ | --------------------------------------- |
| `type`     | string | Event type (see below)                  |
| `entityId` | string | The `approvalId` this event pertains to |
| `payload`  | object | Event-specific data                     |

### Event Types

#### `approval.approved`

Human approved the gate. `payload.token` is the one-time token for verify-token.

```json
{
  "type": "approval.approved",
  "entityId": "app_01jdx8wq4dj2k",
  "payload": { "token": "tkn_xyz789abc" }
}
```

On receiving this event:

1. Verify `entityId === approvalId` of the gate you're waiting on
2. Call `POST /v1/verify-token` with the token

#### `approval.rejected`

Human rejected the gate. Clean up local state, fire `onGateRejected` hook, throw `MeshgateRejectedError`.

```json
{
  "type": "approval.rejected",
  "entityId": "app_01jdx8wq4dj2k",
  "payload": {}
}
```

#### `approval.expired`

Gate TTL elapsed. Clean up local state, fire `onGateExpired` hook, throw `MeshgateExpiredError`.

```json
{
  "type": "approval.expired",
  "entityId": "app_01jdx8wq4dj2k",
  "payload": {}
}
```

### Stream and Client-Side Filtering

The SDK should narrow the stream server-side, then filter client-side by
approval ID:

```
GET /v1/events/stream?eventTypes=approval.approved,approval.rejected,approval.expired

Act on events where:
  event.type in {'approval.approved', 'approval.rejected', 'approval.expired'}
  AND event.entityId === <your specific approvalId>
```

Discard all other events silently. Older Meshgate APIs may ignore the query
parameter and return a broader stream, so client-side approval ID filtering
remains required.

### Reconnect Strategy

```
Connection drops:
  → Reconnect immediately (attempt 1, no delay)
  → If fails: wait 1s (attempt 2)
  → If fails: wait 2s (attempt 3)
  → If fails after 3 attempts: switch to polling mode (§6)

Once polling returns 'approved': the approved event was missed,
proceed with verify-token using the token from the status response.
```

**Implementation note:** Use `fetch()` with a streaming response body (`response.body` as a readable stream) rather than the browser `EventSource` global. `EventSource` is not available in Cloudflare Workers, Vercel Edge Runtime, or Node.js without polyfills. `fetch()` streaming works everywhere.

---

## 6. GET /v1/approvals/:id/status — Polling Fallback

**Purpose:** Check the current state of a gate. Used when SSE fails or in `reconcile()`.
**Scope required:** `sdk:read`

### Request

```
GET /v1/approvals/{approvalId}/status
Authorization: Bearer {apiKey}
```

No request body.

### Response — 200 OK

```json
{
  "id": "app_01jdx8wq4dj2k",
  "status": "approved",
  "resolvedAt": "2026-04-07T09:22:15.000Z",
  "token": "tkn_xyz789abc",
  "gateNonce": null
}
```

| Field        | Type           | Description                                                                                                                                                                                                              |
| ------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`         | string         | The approval ID                                                                                                                                                                                                          |
| `status`     | string         | `"pending"` \| `"approved"` \| `"rejected"` \| `"expired"`                                                                                                                                                               |
| `resolvedAt` | string \| null | ISO-8601 timestamp of resolution. Null if still pending.                                                                                                                                                                 |
| `token`      | string \| null | One-time token for verify-token. Present only when `status=approved` and not yet burned. Null otherwise.                                                                                                                 |
| `gateNonce`  | string \| null | The gateNonce for this gate. May be present when `status=approved`. **Note:** The authoritative gateNonce for key re-derivation is returned by `POST /v1/verify-token`, not here — always use the verify-token response. |

### Status Semantics

| `status`   | `token`  | SDK action                                                               |
| ---------- | -------- | ------------------------------------------------------------------------ |
| `pending`  | null     | Continue polling with exponential backoff                                |
| `approved` | non-null | Call `POST /v1/verify-token` with the token                              |
| `approved` | null     | Token already burned → orphaned → fire `onGateOrphaned`                  |
| `rejected` | null     | Fire `onGateRejected`, delete local state, throw `MeshgateRejectedError` |
| `expired`  | null     | Fire `onGateExpired`, delete local state, throw `MeshgateExpiredError`   |

### Error Responses

| Status        | SDK action                                |
| ------------- | ----------------------------------------- |
| `401` / `403` | Fire `onGateOrphaned`, stop polling       |
| `404`         | Fire `onGateOrphaned`, delete local state |
| `5xx`         | Continue polling with backoff             |

### Polling Backoff Schedule

When in polling mode (after SSE fallback or during `reconcile()`):

```
Attempt 1: wait 1s
Attempt 2: wait 2s
Attempt 3: wait 4s
Attempt 4: wait 8s
Attempt 5: wait 16s
Attempt 6+: wait 30s (cap — continue until resolved or expired)
```

---

## 7. POST /v1/verify-token — Atomic Phone-Home

**Purpose:** Burn the one-time token, retrieve the gateNonce for key re-derivation.
**Scope required:** `sdk:read`
**Timeout per attempt:** 10 seconds
**Retryable:** Yes (5xx — see §10.3)

**This call is mandatory.** The SDK never decrypts local state or calls `fn()` without a `200` from this endpoint. Even if you receive an `approval.approved` SSE event with a valid-looking token, you must phone home.

### Request

```
POST /v1/verify-token
Authorization: Bearer {apiKey}
Content-Type: application/json
```

```json
{
  "approvalId": "app_01jdx8wq4dj2k",
  "token": "tkn_xyz789abc"
}
```

### Response — 200 OK

```json
{
  "verified": true,
  "context": {
    "approvalId": "app_01jdx8wq4dj2k",
    "intent": "process_refund",
    "approvedBy": "alice@example.com",
    "payloadHash": "ejv7gfOD9pQzrW6QDTWz4jhVk/dqe3q1nUNVuLpB7iU=",
    "gateNonce": "dGVzdG5vbmNlX3ZhbHVlXzMyYnl0ZXNfYmFzZTY0dXJs",
    "resolvedAt": "2026-04-07T09:22:15.000Z"
  }
}
```

After receiving this `200`:

1. Use `context.gateNonce` to re-derive the AES-256-GCM key via HKDF (see §8.2)
2. Decrypt the locally stored ciphertext (see §8.4)
3. Recompute `base64(SHA-256(JSON.stringify(decryptedArgs)))` — must equal `context.payloadHash`
4. If hash mismatch: throw `MeshgateTamperError`, do NOT call `fn()`
5. If hash matches: delete local state, call `fn()` with decrypted args, return result

### Error Responses

| Status | Error Code            | SDK action                                                                  |
| ------ | --------------------- | --------------------------------------------------------------------------- |
| `400`  | `token_hash_mismatch` | Throw `MeshgateTamperError` — execution aborted                             |
| `401`  | `unauthorized`        | Throw `MeshgateAuthError`                                                   |
| `403`  | `token_exhausted`     | Token already burned → fire `onGateOrphaned`, throw `MeshgateOrphanedError` |
| `403`  | `forbidden`           | Throw `MeshgateAuthError`                                                   |
| `404`  | —                     | Fire `onGateOrphaned`, delete local state                                   |
| `5xx`  | —                     | Retryable — 3 attempts with 0s/1s/2s backoff (see §10.3)                    |

---

## 8. Encryption Scheme

### 8.1 — gateNonce Generation

```python
import secrets, base64

# 32 cryptographically random bytes
nonce_bytes = secrets.token_bytes(32)

# base64url-encode (no padding)
gate_nonce = base64.urlsafe_b64encode(nonce_bytes).rstrip(b'=').decode('ascii')
```

The gateNonce is generated by the SDK immediately before calling `POST /v1/intent`. It is:

- Sent to the cloud in the `POST /v1/intent` request body
- Never stored locally (split-knowledge property)
- Returned by the cloud in the `POST /v1/verify-token` response as `context.gateNonce`
- Used as the HKDF salt for key derivation (see §8.2)

### 8.2 — Key Derivation (HKDF-SHA256)

One AES-256-GCM key is derived per gate and never persisted. The key is re-derivable from `MESHGATE_LOCAL_SECRET` + `gateNonce`.

```
gateEncryptionKey = HKDF-SHA256(
  ikm:    UTF-8 bytes of MESHGATE_LOCAL_SECRET
  salt:   base64url-decoded bytes of gateNonce (32 bytes)
  info:   UTF-8 bytes of "meshgate-v1"
  length: 32 bytes (256-bit key for AES-256-GCM)
)
```

**Python example using `cryptography` library:**

```python
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes
import base64

def derive_gate_key(master_secret: str, gate_nonce: str) -> bytes:
    # Add padding back for standard base64url decode
    padding = 4 - len(gate_nonce) % 4
    nonce_bytes = base64.urlsafe_b64decode(gate_nonce + '=' * padding)

    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=nonce_bytes,
        info=b'meshgate-v1',
    )
    return hkdf.derive(master_secret.encode('utf-8'))
```

**TypeScript (Web Crypto API) — reference implementation:**

```typescript
async function deriveGateKey(masterSecret: string, gateNonce: string): Promise<CryptoKey> {
  const masterBytes = new TextEncoder().encode(masterSecret);
  const nonceBytes = base64urlDecode(gateNonce); // 32 bytes
  const infoBytes = new TextEncoder().encode('meshgate-v1');

  const ikm = await crypto.subtle.importKey('raw', masterBytes, 'HKDF', false, ['deriveKey']);

  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: nonceBytes, info: infoBytes },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
```

**Why HKDF, not PBKDF2:** `MESHGATE_LOCAL_SECRET` is already high-entropy (≥32 chars of random material). HKDF is the correct primitive for deriving keys from high-entropy keying material. PBKDF2 is designed for low-entropy passwords.

### 8.3 — payloadHash Computation

```
payloadHash = base64(SHA-256(JSON.stringify(args)))
```

Where `args` is the exact JavaScript/Python array/list of arguments passed to the wrapped function.

**Important:** `JSON.stringify` must produce a **stable, deterministic** string. Use the same serialization at encrypt time and verify time — the hash must match exactly.

**Python example:**

```python
import json, hashlib, base64

def compute_payload_hash(args: list) -> str:
    # Use separators=(',', ':') to match JavaScript's JSON.stringify with no spaces
    serialized = json.dumps(args, separators=(',', ':'), ensure_ascii=False)
    digest = hashlib.sha256(serialized.encode('utf-8')).digest()
    return base64.b64encode(digest).decode('ascii')
```

**JavaScript reference:**

```javascript
const serialized = JSON.stringify(args); // compact, no spaces
const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
const payloadHash = btoa(String.fromCharCode(...new Uint8Array(digest)));
```

**Serialization contract:** All argument values must be JSON-serializable: strings, numbers, booleans, plain objects, arrays, `null`. Non-serializable values (`Date`, class instances, functions, Symbols, circular refs) must throw a serialization error **before** any network calls.

### 8.4 — AES-256-GCM Encryption

The plaintext `GatePayload` object is encrypted with AES-256-GCM using the derived key.

**GatePayload structure (plaintext before encryption):**

```json
{
  "schemaVersion": "1",
  "args": ["cust_123", 750]
}
```

**Encryption parameters:**

| Parameter                     | Value                                                    |
| ----------------------------- | -------------------------------------------------------- |
| Algorithm                     | AES-256-GCM                                              |
| Key                           | 32-byte derived key from §8.2                            |
| IV / nonce                    | 12 random bytes per encryption (distinct from gateNonce) |
| Authentication tag            | 16 bytes (GCM default)                                   |
| Plaintext                     | UTF-8 encoded `JSON.stringify(gatePayload)`              |
| Additional authenticated data | none                                                     |

**Python example:**

```python
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import os, base64, json

def encrypt_gate_payload(key: bytes, gate_payload: dict) -> dict:
    iv = os.urandom(12)  # 12-byte random IV
    plaintext = json.dumps(gate_payload, separators=(',', ':')).encode('utf-8')

    aesgcm = AESGCM(key)
    # cryptography appends the 16-byte auth tag to the ciphertext
    ciphertext_with_tag = aesgcm.encrypt(iv, plaintext, None)

    ciphertext = ciphertext_with_tag[:-16]
    auth_tag = ciphertext_with_tag[-16:]

    return {
        'iv': base64.b64encode(iv).decode('ascii'),
        'authTag': base64.b64encode(auth_tag).decode('ascii'),
        'ciphertext': base64.b64encode(ciphertext).decode('ascii'),
    }

def decrypt_gate_payload(key: bytes, iv_b64: str, auth_tag_b64: str, ciphertext_b64: str) -> dict:
    iv = base64.b64decode(iv_b64)
    auth_tag = base64.b64decode(auth_tag_b64)
    ciphertext = base64.b64decode(ciphertext_b64)

    aesgcm = AESGCM(key)
    # cryptography expects ciphertext + tag concatenated
    plaintext = aesgcm.decrypt(iv, ciphertext + auth_tag, None)
    return json.loads(plaintext.decode('utf-8'))
```

**Decryption failure:** If the ciphertext or auth tag was modified (tampered), AES-GCM decryption throws an `InvalidTag` exception before any plaintext is returned. This is the first tamper detection layer. The SDK must re-raise this as `MeshgateTamperError` and never call `fn()`.

---

## 9. Storage Format

Each pending gate is persisted as a JSON string in the storage adapter, keyed by `approvalId`.

### StoredGateRecord

```json
{
  "schemaVersion": "1",
  "approvalId": "app_01jdx8wq4dj2k",
  "intent": "process_refund",
  "expiresAt": "2026-04-08T14:00:00.000Z",
  "iv": "aGVsbG8gd29ybGQh",
  "authTag": "c29tZXRoaW5nX3NhZmU=",
  "ciphertext": "ZW5jcnlwdGVkX2RhdGFfZ29lc19oZXJl"
}
```

| Field           | Type   | Description                                                            |
| --------------- | ------ | ---------------------------------------------------------------------- |
| `schemaVersion` | `"1"`  | Always `"1"` for v2.2 records                                          |
| `approvalId`    | string | Storage key and cloud approval ID                                      |
| `intent`        | string | Plaintext intent name (used for reconcile routing)                     |
| `expiresAt`     | string | ISO-8601 expiry (used for local expiry check without decryption)       |
| `iv`            | string | base64-encoded AES-GCM IV (12 bytes)                                   |
| `authTag`       | string | base64-encoded AES-GCM authentication tag (16 bytes)                   |
| `ciphertext`    | string | base64-encoded AES-GCM ciphertext of the JSON-serialized `GatePayload` |

**INVARIANT: `gateNonce` is NOT in this record.** It is held by the Meshgate cloud and returned only on a successful `POST /v1/verify-token`. This is the split-knowledge security property:

- Local storage: has ciphertext, no nonce → cannot decrypt alone
- Meshgate cloud: has nonce, no master secret → cannot decrypt alone
- Both together → decryptable, but only after phone-home (human authorization)

### FileSystem Layout (Node.js)

```
.meshgate/
  {approvalId}.json    ← one StoredGateRecord per pending gate
```

The `.meshgate/` directory must be added to `.gitignore`.

### Cloudflare KV Layout

```
KV key: mg:{approvalId}    ← one entry per pending gate
```

`listKeys()` uses `kv.list({ prefix: 'mg:' })` and strips the `mg:` prefix.

---

## 10. Retry and Failure Contracts

### 10.1 — POST /v1/intent Retry Logic

| Condition              | Retryable | Backoff                                      | After exhaustion                            |
| ---------------------- | --------- | -------------------------------------------- | ------------------------------------------- |
| `503` response         | Yes       | 0s, 1s, 2s (3 attempts)                      | Throw `MeshgateNetworkError`                |
| Network timeout (>10s) | Yes       | 0s, 1s, 2s (3 attempts)                      | Throw `MeshgateNetworkError`                |
| `429` response         | Yes       | `Retry-After` header (seconds), then 1 retry | Throw `MeshgateNetworkError` if retry fails |
| `400`                  | No        | —                                            | Throw `MeshgateConfigError`                 |
| `401`                  | No        | —                                            | Throw `MeshgateAuthError`                   |
| `403`                  | No        | —                                            | Throw `MeshgateBlockedError`                |
| `422`                  | No        | —                                            | Throw `MeshgateError`                       |

**Fail-closed invariant:** If `POST /v1/intent` fails after all retries, the SDK throws `MeshgateNetworkError` and `fn()` is NOT called. There is no bypass for cloud unavailability.

### 10.2 — GET /v1/approvals/:id/status (polling)

| Condition     | Action                                             |
| ------------- | -------------------------------------------------- |
| `200`         | Process status value (see §6)                      |
| `401` / `403` | Fire `onGateOrphaned`, stop polling                |
| `404`         | Fire `onGateOrphaned`, delete local state          |
| `5xx`         | Continue polling with exponential backoff (see §6) |

### 10.3 — POST /v1/verify-token Retry Logic

| Condition             | Retryable | Backoff                 | After exhaustion              |
| --------------------- | --------- | ----------------------- | ----------------------------- |
| `5xx`                 | Yes       | 0s, 1s, 2s (3 attempts) | Throw `MeshgateNetworkError`  |
| `400`                 | No        | —                       | Throw `MeshgateTamperError`   |
| `401`                 | No        | —                       | Throw `MeshgateAuthError`     |
| `403 token_exhausted` | No        | —                       | Throw `MeshgateOrphanedError` |
| `403 forbidden`       | No        | —                       | Throw `MeshgateAuthError`     |
| `404`                 | No        | —                       | Fire `onGateOrphaned`         |

### 10.4 — Request Timeout

All HTTP requests use a 10-second per-attempt timeout implemented via `AbortController`:

```python
import httpx

with httpx.Client(timeout=10.0) as client:
    response = client.post(url, json=body, headers=headers)
```

---

## 11. Full Flow Walkthrough

This is the complete sequence for a gated function call, from `guard()` invocation to `fn()` execution.

```
Developer calls: await gatedRefund('cust_123', 750)
```

### Step 1 — Validate and Prepare

```
1. Validate args are JSON-serializable
   → If not: throw MeshgateSerializationError (before any network calls)

2. Compute intentArgs via getIntentArgs('cust_123', 750) → { amount: 750 }
   → Validate intentArgs is flat (no nested objects)
   → If not flat: throw MeshgateSerializationError

3. Compute payloadHash = base64(SHA-256(JSON.stringify(['cust_123', 750])))
   → e.g., "ejv7gfOD9pQzrW6QDTWz4jhVk/dqe3q1nUNVuLpB7iU="

4. Generate gateNonce = base64url(crypto.randomBytes(32))
   → e.g., "dGVzdG5vbmNlX3ZhbHVlXzMyYnl0ZXNfYmFzZTY0dXJs"
```

### Step 2 — Register Intent

```
POST /v1/intent {
  intent: "process_refund",
  intentArgs: { amount: 750 },
  payloadHash: "ejv7gf...",
  gateNonce: "dGVzd...",
  expiresInSeconds: 86400
}
```

**Branch on response:**

**→ 200 (allowed):**

```
call fn('cust_123', 750)
return result
done — no storage, no SSE
```

**→ 403 (blocked):**

```
throw MeshgateBlockedError
done — fn() not called
```

**→ 201 (gated):**

```
approvalId = "app_01jdx8wq4dj2k"
expiresAt = "2026-04-08T14:00:00.000Z"
→ continue to Step 3
```

### Step 3 — Encrypt and Store

```
3a. Derive key:
    gateKey = HKDF-SHA256(
      ikm = UTF-8(MESHGATE_LOCAL_SECRET),
      salt = base64url_decode(gateNonce),
      info = UTF-8("meshgate-v1"),
      length = 32
    )

3b. Encrypt GatePayload:
    plaintext = JSON.stringify({ schemaVersion: "1", args: ["cust_123", 750] })
    iv = random_bytes(12)
    { ciphertext, authTag } = AES-256-GCM.encrypt(key=gateKey, iv=iv, plaintext)

3c. Write StoredGateRecord to adapter:
    adapter.set("app_01jdx8wq4dj2k", JSON.stringify({
      schemaVersion: "1",
      approvalId: "app_01jdx8wq4dj2k",
      intent: "process_refund",
      expiresAt: "2026-04-08T14:00:00.000Z",
      iv: base64(iv),
      authTag: base64(authTag),
      ciphertext: base64(ciphertext)
    }))

3d. gateNonce is NOT stored locally.
    gateKey is NOT stored locally (used once, then GC'd).
```

### Step 4 — Subscribe SSE

```
GET /v1/events/stream
Authorization: Bearer {apiKey}

Listen for events where:
  type === "approval.approved" AND entityId === "app_01jdx8wq4dj2k"

[Human approves in Meshgate dashboard]

SSE event received:
  { "type": "approval.approved", "entityId": "app_01jdx8wq4dj2k", "payload": { "token": "tkn_xyz789" } }

→ Proceed to Step 5 with token = "tkn_xyz789"
```

If SSE drops 3 times, switch to polling (§6) until `status=approved` with token.

### Step 5 — Phone Home (Mandatory)

```
POST /v1/verify-token {
  approvalId: "app_01jdx8wq4dj2k",
  token: "tkn_xyz789"
}

→ 200 {
  verified: true,
  context: {
    gateNonce: "dGVzdG5vbmNlX3ZhbHVlXzMyYnl0ZXNfYmFzZTY0dXJs",
    payloadHash: "ejv7gfOD9pQzrW6QDTWz4jhVk/dqe3q1nUNVuLpB7iU=",
    ...
  }
}
```

### Step 6 — Verify, Decrypt, Execute

```
6a. Re-derive gateKey using context.gateNonce:
    freshKey = HKDF-SHA256(
      ikm = UTF-8(MESHGATE_LOCAL_SECRET),
      salt = base64url_decode(context.gateNonce),
      info = UTF-8("meshgate-v1")
    )
    [context.gateNonce matches the original — same key is derived]

6b. Read StoredGateRecord from adapter:
    record = adapter.get("app_01jdx8wq4dj2k")

6c. Decrypt:
    decryptedPayload = AES-256-GCM.decrypt(
      key=freshKey, iv=record.iv, authTag=record.authTag, ciphertext=record.ciphertext
    )
    → { schemaVersion: "1", args: ["cust_123", 750] }
    [If auth tag invalid → throw MeshgateTamperError, fn() not called]

6d. Verify payloadHash:
    recomputed = base64(SHA-256(JSON.stringify(["cust_123", 750])))
    assert recomputed === context.payloadHash
    [If mismatch → throw MeshgateTamperError, fn() not called]

6e. Clean up and execute:
    adapter.delete("app_01jdx8wq4dj2k")
    return fn("cust_123", 750)
```

---

## 12. Cold Resume — reconcile() Flow

`reconcile()` must be called once on startup, after all `guard()` registrations, to resume any pending gates that survived a process restart.

```python
# Startup contract (all languages):

# 1. Register all intent handlers first
gated_refund = client.guard(process_refund, intent='process_refund')
gated_deploy = client.guard(deploy, intent='deploy_to_production')

# 2. Then reconcile
result = await client.reconcile()
```

### reconcile() Algorithm

```
1. keys = adapter.listKeys()

2. For each approvalId in keys:

   a. record = JSON.parse(adapter.get(approvalId))
   b. If record is None: skip (deleted between list and get)

   c. LOCAL EXPIRY CHECK:
      If datetime.now() >= datetime.fromisoformat(record.expiresAt):
        adapter.delete(approvalId)
        fire onGateExpired(gate)
        add to result.expired
        continue

   d. CLOUD STATUS CHECK:
      status = GET /v1/approvals/{approvalId}/status
        → If 404: orphaned (delete + hook + add to orphaned, continue)
        → If 401/403: orphaned (delete + hook + add to orphaned, continue)

   e. BRANCH ON STATUS:

      status = "pending":
        Re-subscribe to SSE for this approvalId
        Add to result.pending
        continue

      status = "rejected":
        adapter.delete(approvalId)
        fire onGateRejected(gate)
        add to result.rejected
        continue

      status = "expired":
        adapter.delete(approvalId)
        fire onGateExpired(gate)
        add to result.expired
        continue

      status = "approved", token = None:
        # Token was already burned by another process
        adapter.delete(approvalId)
        fire onGateOrphaned(gate)
        add to result.orphaned
        continue

      status = "approved", token = <value>:
        # Phone home
        verifyResp = POST /v1/verify-token { approvalId, token }
          → If 403 token_exhausted or 404: orphaned (delete + hook + add to orphaned)
          → If 5xx after retries: throw (propagate — don't silently swallow)

        # Re-derive key and decrypt (same as §11 Step 6)
        freshKey = HKDF(masterSecret, verifyResp.context.gateNonce)
        payload = AES-256-GCM.decrypt(freshKey, record.iv, record.authTag, record.ciphertext)

        # payloadHash verification
        recomputed = base64(SHA-256(JSON.stringify(payload.args)))
        If recomputed != verifyResp.context.payloadHash:
          # Tampered — do not execute, treat as orphaned
          adapter.delete(approvalId)
          fire onGateOrphaned(gate)
          add to result.orphaned
          continue

        # Handler lookup
        handler = handlerMap.get(record.intent)
        If handler is None:
          # Intent renamed or removed between deploys
          adapter.delete(approvalId)
          fire onGateOrphaned(gate)
          add to result.orphaned
          continue

        # Execute
        adapter.delete(approvalId)
        await handler.fn(*payload.args)
        add to result.resumed

3. Return ReconcileResult
```

**Idempotency:** `reconcile()` is safe to call multiple times. Each call re-scans the adapter. Gates cleaned up in a prior run are gone from storage and won't appear. No double-execution risk — the gate file is deleted before the handler is called.

---

## 13. Behavioral Invariants

These are non-negotiable invariants that every conforming SDK implementation must enforce:

| #    | Invariant                                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------------------------- |
| I-1  | `fn()` is NEVER called without a 200 response from `POST /v1/verify-token`                                                  |
| I-2  | `fn()` is NEVER called if payloadHash comparison fails after decryption                                                     |
| I-3  | `fn()` is NEVER called if AES-GCM decryption fails (auth tag invalid)                                                       |
| I-4  | `fn()` is NEVER called if `POST /v1/intent` fails after retries (fail-closed)                                               |
| I-5  | `gateNonce` is NEVER stored in local state (split-knowledge)                                                                |
| I-6  | `MESHGATE_LOCAL_SECRET` is NEVER sent to the cloud or logged                                                                |
| I-7  | Plaintext args are NEVER sent to the cloud (only `payloadHash`)                                                             |
| I-8  | `storageAdapter.delete(approvalId)` is called BEFORE `fn()` is called (prevents double-execution on crash-during-execution) |
| I-9  | Debug logs NEVER include: args, payloadHash, gateNonce, iv, ciphertext, apiKey, localEncryptionKey                          |
| I-10 | `reconcile()` never throws if a registered handler is missing — orphan and continue                                         |

---

## 14. Error Reference

| Error Class                  | HTTP Trigger                                                                                                   | Condition                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `MeshgateBlockedError`       | POST /v1/intent → 403 `intent_blocked`                                                                         | Policy blocks the intent                              |
| `MeshgateRejectedError`      | SSE `approval.rejected` or status=rejected                                                                     | Human rejected the approval                           |
| `MeshgateExpiredError`       | SSE `approval.expired`, status=expired, or local expiresAt check                                               | Gate TTL elapsed                                      |
| `MeshgateOrphanedError`      | POST /v1/verify-token → 403 `token_exhausted`, 404; or null token in status; or handler not found in reconcile | Token burned, record missing, or handler renamed      |
| `MeshgateTamperError`        | AES-GCM auth tag failure; or payloadHash mismatch                                                              | Ciphertext tampered or hash mismatch after decryption |
| `MeshgateNetworkError`       | POST /v1/intent or verify-token → 503 / timeout after retries                                                  | Cloud unreachable                                     |
| `MeshgateConfigError`        | POST /v1/intent → 400; constructor validation; duplicate intent; no FS in CF Workers                           | SDK misconfiguration                                  |
| `MeshgateSerializationError` | Before any network call                                                                                        | Args not JSON-serializable; intentArgs not flat       |
| `MeshgateAuthError`          | Any endpoint → 401; POST /v1/verify-token → 403 `forbidden`                                                    | Invalid or unauthorized API key                       |

All error classes extend a base `MeshgateError` with optional `intent` and `approvalId` fields.
