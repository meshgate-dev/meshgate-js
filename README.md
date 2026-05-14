# @meshgate/sdk

TypeScript SDK for [Meshgate](https://meshgate.dev) — Human-in-the-Loop (HITL) authorization for AI agents.

Wrap any async function with a single `.guard()` call. When policy requires human sign-off, execution suspends automatically, notifies your approver, and resumes with the original arguments once approved — all with end-to-end encryption.

## Releasing

SDK releases must pass the release-candidate checklist before publishing to npm.
See [RELEASING.md](./RELEASING.md) for details.

## Installation

```bash
npm install @meshgate/sdk
# or
pnpm add @meshgate/sdk
# or
yarn add @meshgate/sdk
```

**Requirements:** Node.js ≥ 18, or any runtime with the Web Crypto API (`globalThis.crypto.subtle`). Works in Cloudflare Workers, Vercel Edge, Deno, and Bun without polyfills.

## Quick Start

```typescript
import { MeshgateClient } from '@meshgate/sdk';

const client = new MeshgateClient({
  apiKey: process.env.MESHGATE_API_KEY!, // mg_live_... or mg_test_...
  localEncryptionKey: process.env.MESHGATE_LOCAL_SECRET!, // ≥ 32 chars, never sent to cloud
});

// Wrap any async function
const gatedRefund = client.guard(processRefund, {
  intent: 'process_refund',
  getIntentArgs: (customerId, amount) => ({ customerId, amount }),
  description: 'Process customer refund',
});

// Use it exactly like the original function:
// - If policy allows: executes immediately
// - If policy requires approval: suspends until a human approves in the dashboard
// - If policy blocks: throws MeshgateBlockedError
try {
  const result = await gatedRefund('cust_123', 750);
} catch (err) {
  if (err instanceof MeshgateBlockedError) {
    // Policy blocked this action — do not retry
  }
}
```

## Configuration

```typescript
const client = new MeshgateClient({
  // Required
  apiKey: 'mg_live_...',
  localEncryptionKey: 'openssl rand -hex 32 output here',

  // Optional
  baseUrl: 'https://api.meshgate.dev', // default
  storageAdapter: new FileSystemAdapter(), // default on Node.js (see Storage Adapters)
  logLevel: 'info', // debug | info | warn | error

  hooks: {
    onGateExpired: (gate) => console.log('Expired:', gate.approvalId),
    onGateRejected: (gate) => console.log('Rejected:', gate.approvalId),
    onGateOrphaned: (gate) => console.log('Orphaned:', gate.approvalId),
    onGateApproved: (gate) => console.log('Approved:', gate.approvalId),
  },
});
```

### Generating a `localEncryptionKey`

```bash
openssl rand -hex 32
```

This key never leaves your environment. It is used as IKM for HKDF-SHA256 key derivation. Store it in a secret manager (AWS Secrets Manager, Vault, etc.) alongside your API key.

### API Key Format

| Format        | Environment |
| ------------- | ----------- |
| `mg_live_...` | Production  |
| `mg_test_...` | Sandbox     |

## `guard()` Options

```typescript
client.guard(fn, {
  // Required — unique intent name for policy lookup
  intent: 'process_refund',

  // Optional — flat record shown to the approver and used for policy matching.
  // All values must be string | number | boolean. No nested objects, arrays, or null.
  getIntentArgs: (customerId, amount) => ({ customerId, amount }),

  // Optional — gate TTL in seconds (60–604800). Overrides tenant/agent/intent settings.
  expiresInSeconds: 3600,

  // Optional — human-readable description shown in the dashboard (max 1000 chars)
  description: 'Refund $750 for customer cust_123',
});
```

## `@guardrail` Decorator

For class-based code, use the TypeScript 5.x standard decorator. Requires TypeScript ≥ 5.0 with `"experimentalDecorators"` **not** set in `tsconfig.json`.

```typescript
import { guardrail } from '@meshgate/sdk/decorators';

class PaymentService {
  @guardrail(client, {
    intent: 'process_refund',
    getIntentArgs: (_cid: string, amount: number) => ({ amount }),
  })
  async processRefund(customerId: string, amount: number): Promise<Refund> {
    return stripe.refunds.create({ charge: customerId, amount });
  }
}
```

`@guardrail` is equivalent to `processRefund = client.guard(processRefund, options)`. It is imported from a separate entry point (`@meshgate/sdk/decorators`) to keep the main bundle decorator-free.

**Note on `this` binding:** `@guardrail` captures `this` per-call via a shared reference. Safe for single-instance classes and methods that don't read `this`. For multi-instance concurrent usage where the method reads `this`, use `client.guard()` directly.

## Cold Resume After Restart

Gates pending when your process restarted are stored encrypted in the adapter. The `MeshgateClient` constructor automatically scans for and resumes them in the background — no explicit call required. Register all `guard()` functions synchronously after constructing the client and before your app starts accepting work so the handlers are available when the scan processes stored gates.

```typescript
// Construction triggers the background scan automatically.
const client = new MeshgateClient({
  apiKey: process.env.MESHGATE_API_KEY!,
  localEncryptionKey: process.env.MESHGATE_LOCAL_SECRET!,
});

// Register handlers synchronously after construction and before your app starts
// accepting work. The startup scan yields before reading storage, so same-tick
// guard() calls are available for approved gates during cold resume.
const gatedRefund = client.guard(processRefund, { intent: 'process_refund' });
const gatedDelete = client.guard(deleteAccount, { intent: 'delete_account' });

// Approved gates are re-executed, terminal states are cleaned up,
// and still-pending gates are re-subscribed to the SSE stream.
```

Use lifecycle hooks (`onGateApproved`, `onGateRejected`, `onGateExpired`, `onGateOrphaned`) to observe the outcomes of resumed gates.

## Storage Adapters

| Adapter               | Use case                                     |
| --------------------- | -------------------------------------------- |
| `FileSystemAdapter`   | Default on Node.js — stores in `.meshgate/`  |
| `CloudflareKVAdapter` | Cloudflare Workers — requires a KV namespace |
| `NoopAdapter`         | Testing / opt-out of persistence             |

```typescript
import { CloudflareKVAdapter } from '@meshgate/sdk';

// Cloudflare Workers
export default {
  async fetch(req: Request, env: Env) {
    const client = new MeshgateClient({
      apiKey: env.MESHGATE_API_KEY,
      localEncryptionKey: env.MESHGATE_LOCAL_SECRET,
      storageAdapter: new CloudflareKVAdapter(env.MESHGATE_KV),
    });
    // ...
  },
};
```

Implement `MeshgateStorageAdapter` to use any backend (Redis, DynamoDB, etc.):

```typescript
interface MeshgateStorageAdapter {
  listKeys(): Promise<string[]>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

## Error Reference

| Error                        | When it's thrown                                            |
| ---------------------------- | ----------------------------------------------------------- |
| `MeshgateBlockedError`       | Policy blocks the intent (403)                              |
| `MeshgateRejectedError`      | Human rejects the approval                                  |
| `MeshgateExpiredError`       | Gate TTL elapses before approval                            |
| `MeshgateOrphanedError`      | Token already burned, or approval record not found          |
| `MeshgateTamperError`        | Decrypted args don't match the hash stored in the cloud     |
| `MeshgateConfigError`        | Invalid client config or duplicate intent name              |
| `MeshgateSerializationError` | Non-JSON-serializable argument passed to a guarded function |
| `MeshgateAuthError`          | Invalid or insufficient-scope API key (401/403)             |
| `MeshgateNetworkError`       | Unrecoverable network failure after retries                 |

All error classes extend `MeshgateError`.

## Security Model

**Split-knowledge encryption.** Arguments are encrypted with AES-256-GCM before storage:

- Your process holds the `localEncryptionKey` (master secret — never sent to the cloud).
- The Meshgate cloud holds the `gateNonce` (returned only on successful `POST /v1/verify-token`).
- Both are required to decrypt. Neither party can decrypt alone.

**Phone-home invariant.** `fn()` is _never_ called without a successful `POST /v1/verify-token` response. SSE events and polling results are signals only — they initiate verification, not execution.

**Fail-closed.** If `POST /v1/intent` fails (network error, 5xx after retries), `fn()` is not called.

**Tamper detection.** A SHA-256 hash of the serialized arguments is verified after decryption. Any mismatch throws `MeshgateTamperError`.

## Argument Serialization

Arguments to guarded functions must be JSON-serializable:

| Allowed                               | Rejected                               |
| ------------------------------------- | -------------------------------------- |
| `string`, `number`, `boolean`, `null` | `Date`, `Function`, `Symbol`, `BigInt` |
| Plain objects `{}`                    | Class instances                        |
| Arrays `[]`                           | `undefined`                            |
| Nested plain objects/arrays           | Circular references                    |

`getIntentArgs` return values must additionally be **flat** — all values `string | number | boolean`, no nested objects, arrays, or null.

## `debug` Mode

```typescript
const client = new MeshgateClient({ ..., debug: true });
```

Emits structured `console.log` entries for each gate lifecycle event. Logs contain only structural metadata (intent name, approvalId, event type). **Never logs args, keys, nonces, iv, or ciphertext.**

## Wire Protocol

See [PROTOCOL.md](./PROTOCOL.md) for the complete HTTP wire protocol specification (v2.2), including the full encryption scheme, SSE event format, retry contracts, and behavioral invariants.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
