/**
 * MeshgateClient — the primary API surface for @meshgate/sdk.
 *
 * Reduces the full HITL workflow to a single `.guard()` call:
 * validate → register intent → encrypt → store → subscribe SSE →
 * verify-token (phone-home) → decrypt → tamper-check → execute fn().
 *
 * @example
 * ```typescript
 * const client = new MeshgateClient({
 *   apiKey: process.env.MESHGATE_API_KEY!,
 *   localEncryptionKey: process.env.MESHGATE_LOCAL_SECRET!,
 * });
 *
 * const gatedRefund = client.guard(processRefund, {
 *   intent: 'process_refund',
 *   getIntentArgs: (_, amount) => ({ amount }),
 * });
 *
 * const result = await gatedRefund('cust_123', 750);
 * ```
 */

import { FileSystemAdapter } from './adapters/fs-adapter.js';
import type { MeshgateStorageAdapter } from './adapters/types.js';
import { MeshgateApiClient } from './api/client.js';
import type { ApprovalStatusResponse, SseEvent } from './api/types.js';
import {
  MeshgateAuthError,
  MeshgateBlockedError,
  MeshgateConfigError,
  MeshgateExpiredError,
  MeshgateNetworkError,
  MeshgateOrphanedError,
  MeshgateRejectedError,
  MeshgateSerializationError,
  MeshgateTamperError,
} from './errors.js';
import type {
  GateInfo,
  GateOrphanedEvent,
  GateOrphanedReason,
  GatePayload,
  GuardOptions,
  MeshgateConfig,
  ReconcileResult,
  StoredGateRecord,
} from './types.js';
import {
  computePayloadHash,
  decryptGatePayload,
  deriveGateKey,
  encryptGatePayload,
  generateGateNonce,
} from './utils/crypto.js';
import { createLogger } from './utils/logger.js';
import type { Logger } from './utils/logger.js';
import { SseClient } from './utils/sse-client.js';

// ─── Internal types ───────────────────────────────────────────────────────────

interface RegisteredHandler {
  fn: (...args: unknown[]) => Promise<unknown>;
}

/**
 * Callbacks for a gate waiting for a cloud approval event.
 * Populated by both guard() and reconcile() for pending gates.
 */
interface PendingGateEntry {
  gateInfo: GateInfo;
  /** Called with the one-time token when approval.approved fires. */
  onApproved: (token: string) => void;
  /** Called with the error when approval.rejected / approval.expired fires. */
  onTerminated: (err: Error) => void;
}

const DEFAULT_BASE_URL = 'https://api.meshgate.dev';

/** Exponential backoff delays for polling fallback, capped at 30 s. */
const POLL_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

// ─── MeshgateClient ───────────────────────────────────────────────────────────

export class MeshgateClient {
  private readonly api: MeshgateApiClient;
  private readonly adapter: MeshgateStorageAdapter;
  private readonly masterSecret: string;
  private readonly sseUrl: string;
  private readonly sseAuthHeader: Record<string, string>;
  private readonly hooks: NonNullable<MeshgateConfig['hooks']>;
  private readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  private readonly logger: Logger;
  private readonly sseReconnectDelays: number[];

  /** intent name → registered handler, populated by guard(). */
  private readonly handlers = new Map<string, RegisteredHandler>();

  /** approvalId → pending entry, populated by guard() and reconcile(). */
  private readonly pendingGates = new Map<string, PendingGateEntry>();

  /** Shared SSE connection — started lazily on first gated response. */
  private sseClient: SseClient | null = null;

  /**
   * Deduplication guard: if a reconcile is already in progress, return the
   * same Promise rather than starting a second concurrent scan. Cleared via
   * .finally() when the run completes or errors.
   */
  private reconcilePromise: Promise<ReconcileResult> | null = null;

  /**
   * Resolves when the startup reconcile completes (or errors).
   * guard() awaits this before executing to ensure reconcile-registered
   * handlers are processed before new live calls proceed.
   */
  private readonly _reconcileReady: Promise<void>;
  private _resolveReconcileReady!: () => void;

  /**
   * Tracks verify-token calls that are currently in-flight (or were in-flight
   * when a non-fatal error occurred). Used to distinguish:
   * - `token_exhausted_on_retry`: this instance had an in-flight call when the
   *   403 arrived (server burned the token, response was lost, now retrying)
   * - `token_already_used`: no prior in-flight call — another process burned it
   */
  private readonly _pendingVerify = new Set<string>();

  // ─── Constructor ─────────────────────────────────────────────────────────────

  constructor(config: MeshgateConfig) {
    // ── Validate required fields ─────────────────────────────────────────────
    if (!config.apiKey?.trim()) {
      throw new MeshgateConfigError('apiKey is required and must not be empty');
    }
    if (!config.localEncryptionKey || config.localEncryptionKey.length < 32) {
      throw new MeshgateConfigError(
        'localEncryptionKey must be at least 32 characters. ' +
          'Generate one with: openssl rand -hex 32',
      );
    }

    this.masterSecret = config.localEncryptionKey;
    // debug: true is a deprecated alias for logLevel: 'debug'
    if (config.debug === true) {
      console.warn(
        '[meshgate] Config option `debug: true` is deprecated. Use `logLevel: "debug"` instead.',
      );
    }
    this.logLevel = config.debug ? 'debug' : (config.logLevel ?? 'info');
    this.logger = createLogger(this.logLevel);
    this.hooks = config.hooks ?? {};
    this.sseReconnectDelays = config.sseReconnectDelays ?? [0, 1_000, 2_000];

    const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.api = new MeshgateApiClient(config.apiKey, baseUrl);
    this.sseUrl = `${baseUrl}/v1/events/stream`;
    this.sseAuthHeader = { Authorization: `Bearer ${config.apiKey}` };

    this.adapter = config.storageAdapter ?? new FileSystemAdapter();

    // ── Reconcile-ready gate ─────────────────────────────────────────────────
    // guard() awaits this before executing on first call, ensuring startup
    // reconcile completes before new live calls proceed.
    this._reconcileReady = new Promise<void>((resolve) => {
      this._resolveReconcileReady = resolve;
    });

    // Fire startup reconcile in background. The first await inside _reconcileOnStartup()
    // (adapter.listKeys()) yields to the event loop, so any synchronous guard()
    // calls made after construction will have registered their handlers before
    // the scan begins.
    void this._reconcile().finally(() => {
      this._resolveReconcileReady();
    });
  }

  // ─── guard() ─────────────────────────────────────────────────────────────────

  /**
   * Wrap an async function with the Meshgate HITL gate.
   *
   * Returns a new function with the identical TypeScript signature as `fn`.
   * On each call, the returned function runs the full yield-and-hydrate flow:
   * POST /v1/intent → allowed (execute now) | blocked (throw) | gated (wait).
   *
   * @throws {MeshgateConfigError} if `options.intent` is already registered.
   */
  guard<TArgs extends unknown[], TReturn>(
    fn: (...args: TArgs) => Promise<TReturn>,
    options: GuardOptions<TArgs>,
  ): (...args: TArgs) => Promise<TReturn> {
    if (this.handlers.has(options.intent)) {
      throw new MeshgateConfigError(
        `Duplicate intent "${options.intent}": each intent must be unique per MeshgateClient instance`,
        options.intent,
      );
    }

    this.handlers.set(options.intent, {
      fn: fn as (...args: unknown[]) => Promise<unknown>,
    });

    return (...args: TArgs) => this._executeGuard(fn, options, args);
  }

  // ─── Private: startup reconcile ──────────────────────────────────────────────

  /**
   * Internal: scan the storage adapter for pending gates, resume approved ones,
   * clean up terminal states, and re-subscribe SSE for still-pending gates.
   *
   * Called automatically from the constructor. Deduplicates concurrent calls
   * by returning the in-progress Promise if one is already running.
   */
  private _reconcile(): Promise<ReconcileResult> {
    if (!this.reconcilePromise) {
      this.reconcilePromise = this._reconcileOnStartup().finally(() => {
        this.reconcilePromise = null;
      });
    }
    return this.reconcilePromise;
  }

  // ─── Private: guard execution ─────────────────────────────────────────────────

  private async _executeGuard<TArgs extends unknown[], TReturn>(
    fn: (...args: TArgs) => Promise<TReturn>,
    options: GuardOptions<TArgs>,
    args: TArgs,
  ): Promise<TReturn> {
    // Wait for startup reconcile before proceeding (RID-027)
    await this._reconcileReady;

    // 1. Validate args are JSON-serializable
    validateSerializable(args, options.intent);

    // 2. Compute intentArgs and validate flatness
    let intentArgs: Record<string, string | number | boolean> | undefined;
    if (options.getIntentArgs) {
      try {
        intentArgs = options.getIntentArgs(...args);
      } catch (err) {
        throw new MeshgateSerializationError(
          `getIntentArgs threw an error: ${String(err)}`,
          options.intent,
        );
      }
      validateIntentArgsFlatness(intentArgs, options.intent);
    }

    // 3. Compute payloadHash = base64(SHA-256(JSON.stringify(args)))
    const payloadHash = await computePayloadHash(args);

    // 4. Generate gateNonce — 32 random bytes, never stored locally
    const gateNonce = generateGateNonce();

    // 5. POST /v1/intent
    this.log('intent:register', { intent: options.intent });
    const intentResponse = await this.api.registerIntent({
      intent: options.intent,
      intentArgs,
      payloadHash,
      gateNonce,
      expiresInSeconds: options.expiresInSeconds,
      description: options.description,
    });

    // 6. Handle the three possible outcomes

    // ── 200: allowed — execute immediately ──────────────────────────────────
    if (intentResponse.outcome === 'allowed') {
      this.log('intent:allowed', { intent: options.intent });
      return fn(...args);
    }

    // ── 403: blocked — fn() NOT called ──────────────────────────────────────
    if (intentResponse.outcome === 'blocked') {
      this.log('intent:blocked', { intent: options.intent });
      throw new MeshgateBlockedError(
        `Intent "${options.intent}" was blocked by policy`,
        options.intent,
      );
    }

    // ── 201: gated — enter yield-and-hydrate flow ────────────────────────────
    const { approvalId, expiresAt } = intentResponse;
    const gateInfo: GateInfo = { approvalId, intent: options.intent, expiresAt };
    this.log('intent:gated', { intent: options.intent, approvalId });

    // Derive per-gate AES-256-GCM key via HKDF (key is non-extractable, never persisted)
    const gateKey = await deriveGateKey(this.masterSecret, gateNonce);

    // Encrypt args — gateNonce is NOT stored locally (split-knowledge property)
    const { iv, authTag, ciphertext } = await encryptGatePayload(gateKey, {
      schemaVersion: '1',
      args,
    });

    const record: StoredGateRecord = {
      schemaVersion: '1',
      approvalId,
      intent: options.intent,
      expiresAt,
      iv,
      authTag,
      ciphertext,
      createdAt: Date.now(),
    };
    await this.adapter.set(approvalId, JSON.stringify(record));

    // Register the pending gate before opening SSE so an immediate connection
    // failure can safely fall back to polling this approval.
    const approvalTokenPromise = new Promise<string>((resolve, reject) => {
      this.pendingGates.set(approvalId, {
        gateInfo,
        onApproved: resolve,
        onTerminated: reject,
      });
    });
    this.ensureSseStarted();

    // Wait for approval signal from SSE or polling fallback
    let token: string;
    try {
      token = await approvalTokenPromise;
    } catch (err) {
      // Gate reached a terminal state (rejected / expired / orphaned)
      await this.adapter.delete(approvalId);
      this.cleanupAfterGate();
      if (err instanceof MeshgateRejectedError) {
        await this.fireHook('onGateRejected', gateInfo);
      } else if (err instanceof MeshgateExpiredError) {
        await this.fireHook('onGateExpired', gateInfo);
      } else if (!(err instanceof MeshgateOrphanedError)) {
        // MeshgateOrphanedError: hook already fired inside _verifyDecryptAndExecute —
        // skip to avoid double-firing onGateOrphaned for the same gate.
        await this.fireOrphanedHook({
          ...gateInfo,
          reason: 'verify_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }

    // Phone-home verify-token (mandatory — fn() is NEVER called without this)
    const result = await this._verifyDecryptAndExecute(record, gateInfo, token, fn);
    await this.fireHook('onGateApproved', gateInfo);
    return result;
  }

  /**
   * Perform the mandatory phone-home verification, decrypt local state,
   * verify the payloadHash, and execute fn() with the decrypted args.
   *
   * This is called both from the live guard() flow and from reconcile().
   */
  private async _verifyDecryptAndExecute<TArgs extends unknown[], TReturn>(
    record: StoredGateRecord,
    gateInfo: GateInfo,
    token: string,
    fn: (...args: TArgs) => Promise<TReturn>,
  ): Promise<TReturn> {
    // Track this verify-token call for token_exhausted_on_retry detection (RID-015 to RID-019).
    // wasAlreadyPending = true means this SDK instance had a prior in-flight call for the
    // same approvalId that ended without a success (e.g. response was lost on the network).
    const wasAlreadyPending = this._pendingVerify.has(record.approvalId);
    this._pendingVerify.add(record.approvalId);

    // Phone-home: atomic token burn
    let verifyRes;
    try {
      verifyRes = await this.api.verifyToken({ approvalId: record.approvalId, token });
      this._pendingVerify.delete(record.approvalId);
    } catch (err) {
      if (err instanceof MeshgateOrphanedError) {
        // Terminal — clean up tracking and determine precise reason
        this._pendingVerify.delete(record.approvalId);
        await this.adapter.delete(record.approvalId);
        const reason: GateOrphanedReason =
          err.reason === 'token_exhausted'
            ? wasAlreadyPending
              ? 'token_exhausted_on_retry'
              : 'token_already_used'
            : 'gate_not_found';
        await this.fireOrphanedHook({ ...gateInfo, reason, message: err.message });
      } else {
        // Network/timeout errors: keep in _pendingVerify so a retry of the same
        // approvalId within this process is correctly identified as a potential retry.
        await this.adapter.delete(record.approvalId);
      }
      throw err;
    }

    const resolvedNonce = verifyRes.context.gateNonce;
    if (!resolvedNonce) {
      this._pendingVerify.delete(record.approvalId);
      await this.adapter.delete(record.approvalId);
      await this.fireOrphanedHook({
        ...gateInfo,
        reason: 'verify_failed',
        message: 'verify-token response is missing gateNonce',
      });
      throw new MeshgateOrphanedError(
        'verify-token response is missing gateNonce',
        gateInfo.intent,
        record.approvalId,
      );
    }

    // Re-derive key using the cloud-held gateNonce (never stored locally)
    const key = await deriveGateKey(this.masterSecret, resolvedNonce);

    // Decrypt — auth tag failure means ciphertext was tampered
    let payload: GatePayload;
    try {
      payload = await decryptGatePayload(key, record.iv, record.authTag, record.ciphertext);
    } catch {
      await this.adapter.delete(record.approvalId);
      throw new MeshgateTamperError(
        'AES-GCM authentication failed — local ciphertext may have been tampered',
        gateInfo.intent,
        record.approvalId,
      );
    }

    // Verify payloadHash (tamper detection against cloud-stored hash)
    const cloudHash = verifyRes.context.payloadHash;
    if (cloudHash) {
      const recomputed = await computePayloadHash(payload.args);
      if (recomputed !== cloudHash) {
        await this.adapter.delete(record.approvalId);
        throw new MeshgateTamperError(
          'payloadHash mismatch — function arguments may have been tampered',
          gateInfo.intent,
          record.approvalId,
        );
      }
    }

    // All checks passed — execute fn() with decrypted args
    await this.adapter.delete(record.approvalId);
    this.log('intent:executing', { intent: gateInfo.intent, approvalId: record.approvalId });

    return fn(...(payload.args as TArgs));
  }

  // ─── Private: reconcile ──────────────────────────────────────────────────────

  private async _reconcileOnStartup(): Promise<ReconcileResult> {
    const result: ReconcileResult = {
      resumed: [],
      rejected: [],
      expired: [],
      orphaned: [],
      pending: [],
    };

    const keys = await this.adapter.listKeys();

    // ── Phase 1: load records, check local expiry, fetch cloud status ─────────
    // Collect approved and pending gates for ordered processing in phase 2/3.
    type GateData = {
      record: StoredGateRecord;
      gateInfo: GateInfo;
      status: ApprovalStatusResponse;
    };
    const approvedGates: GateData[] = [];
    const pendingGates: GateData[] = [];

    for (const approvalId of keys) {
      const raw = await this.adapter.get(approvalId);
      if (!raw) continue;

      let record: StoredGateRecord;
      try {
        record = JSON.parse(raw) as StoredGateRecord;
      } catch {
        // Corrupted record — delete silently
        await this.adapter.delete(approvalId);
        continue;
      }

      // Validate required fields and schemaVersion
      if (
        record.schemaVersion !== '1' ||
        !record.approvalId ||
        !record.intent ||
        !record.expiresAt ||
        !record.iv ||
        !record.authTag ||
        !record.ciphertext
      ) {
        await this.adapter.delete(approvalId);
        continue;
      }

      const gateInfo: GateInfo = {
        approvalId: record.approvalId,
        intent: record.intent,
        expiresAt: record.expiresAt,
      };

      // ── Local expiry check (no network call) ──────────────────────────────
      const expiryDate = new Date(record.expiresAt);
      if (isNaN(expiryDate.getTime()) || expiryDate < new Date()) {
        await this.adapter.delete(approvalId);
        await this.fireHook('onGateExpired', gateInfo);
        result.expired.push(gateInfo);
        continue;
      }

      // ── Check cloud status ────────────────────────────────────────────────
      let status: ApprovalStatusResponse;
      try {
        status = await this.api.getApprovalStatus(approvalId);
      } catch {
        // 404 / auth failure → treat as orphaned
        await this.adapter.delete(approvalId);
        await this.fireOrphanedHook({
          ...gateInfo,
          reason: 'gate_not_found',
          message: 'Approval record not found in cloud',
        });
        result.orphaned.push(gateInfo);
        continue;
      }

      if (status.status === 'rejected') {
        await this.adapter.delete(approvalId);
        await this.fireHook('onGateRejected', gateInfo);
        result.rejected.push(gateInfo);
      } else if (status.status === 'expired') {
        await this.adapter.delete(approvalId);
        await this.fireHook('onGateExpired', gateInfo);
        result.expired.push(gateInfo);
      } else if (status.status === 'approved') {
        if (!status.token) {
          // Token already burned by another process
          await this.adapter.delete(approvalId);
          await this.fireOrphanedHook({
            ...gateInfo,
            reason: 'token_already_used',
            message: 'Token already consumed by another process',
          });
          result.orphaned.push(gateInfo);
        } else {
          approvedGates.push({ record, gateInfo, status });
        }
      } else {
        // status === 'pending' — collect for re-subscription after sorting
        pendingGates.push({ record, gateInfo, status });
      }
    }

    // ── Phase 2: sort approved by resolvedAt desc (most recently approved first) ──
    // This ensures the freshest approvals execute first, reducing time-to-execution
    // for recently approved gates after a cold resume (RID-026).
    approvedGates.sort((a, b) => {
      const ta = a.status.resolvedAt ? new Date(a.status.resolvedAt).getTime() : 0;
      const tb = b.status.resolvedAt ? new Date(b.status.resolvedAt).getTime() : 0;
      return tb - ta;
    });

    // ── Phase 3: sort pending by createdAt asc (oldest first — FIFO) (RID-026) ──
    pendingGates.sort((a, b) => (a.record.createdAt ?? 0) - (b.record.createdAt ?? 0));

    // ── Phase 4: process approved gates in sorted order ───────────────────────
    for (const { record, gateInfo, status } of approvedGates) {
      const resumed = await this._reconcileApproved(record, gateInfo, status.token!);
      if (resumed) {
        result.resumed.push(gateInfo);
      } else {
        result.orphaned.push(gateInfo);
      }
    }

    // ── Phase 5: re-subscribe SSE for pending gates in sorted order ───────────
    for (const { record, gateInfo } of pendingGates) {
      this.ensureSseStarted();
      this.pendingGates.set(gateInfo.approvalId, {
        gateInfo,
        onApproved: (tok) => {
          void this._reconcileApproved(record, gateInfo, tok);
        },
        onTerminated: (err) => {
          void this._reconcileTerminated(gateInfo, err);
        },
      });
      result.pending.push(gateInfo);
    }

    return result;
  }

  /**
   * Verify-token, decrypt, look up handler, and execute for a gate approved
   * during reconcile(). Returns true if the handler executed successfully.
   */
  private async _reconcileApproved(
    record: StoredGateRecord,
    gateInfo: GateInfo,
    token: string,
  ): Promise<boolean> {
    const handler = this.handlers.get(record.intent);
    if (!handler) {
      // Intent handler not registered — renamed or removed between deploys
      await this.adapter.delete(record.approvalId);
      this.pendingGates.delete(record.approvalId);
      await this.fireOrphanedHook({
        ...gateInfo,
        reason: 'gate_not_found',
        message: `No handler registered for intent "${record.intent}" — was it renamed or removed?`,
      });
      return false;
    }

    try {
      await this._verifyDecryptAndExecute(record, gateInfo, token, async (...args: unknown[]) => {
        try {
          await handler.fn(...args);
        } catch {
          // Handler errors don't fail reconcile — the gate was successfully resumed
        }
      });
    } catch (err) {
      this.pendingGates.delete(record.approvalId);
      if (err instanceof MeshgateTamperError) {
        // In the reconcile path, AES-GCM auth failure most likely indicates key rotation
        // (MESHGATE_LOCAL_SECRET changed since this gate was created). Fire decryption_failed
        // rather than propagating the tamper error — the gate record was already deleted
        // inside _verifyDecryptAndExecute. (RID-020, RID-021)
        await this.fireOrphanedHook({
          ...gateInfo,
          reason: 'decryption_failed',
          message:
            'Local encryption key may have been rotated. Existing gates cannot be decrypted.',
        });
      }
      // MeshgateOrphanedError: hook already fired inside _verifyDecryptAndExecute
      return false;
    }

    this.pendingGates.delete(record.approvalId);
    this.cleanupAfterGate();
    await this.fireHook('onGateApproved', gateInfo);
    return true;
  }

  /** Clean up a pending gate that reached a terminal state during reconcile. */
  private async _reconcileTerminated(gateInfo: GateInfo, err: Error): Promise<void> {
    await this.adapter.delete(gateInfo.approvalId);
    this.pendingGates.delete(gateInfo.approvalId);
    this.cleanupAfterGate();

    if (err instanceof MeshgateRejectedError) {
      await this.fireHook('onGateRejected', gateInfo);
    } else if (err instanceof MeshgateExpiredError) {
      await this.fireHook('onGateExpired', gateInfo);
    } else {
      await this.fireOrphanedHook({
        ...gateInfo,
        reason: 'verify_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── Private: SSE ────────────────────────────────────────────────────────────

  private ensureSseStarted(): void {
    if (this.sseClient) return;

    this.sseClient = new SseClient(this.sseUrl, this.sseAuthHeader, {
      onEvent: (event) => this.handleSseEvent(event),
      onPollFallback: () => this.handleSseFallback(),
      onError: (err) => this.log('sse:error', { error: String(err) }),
      reconnectDelays: this.sseReconnectDelays,
    });
    this.sseClient.start();
    this.log('sse:started', {});
  }

  private handleSseEvent(event: SseEvent): void {
    const entry = this.pendingGates.get(event.entityId);
    if (!entry) return;

    const approvalId = event.entityId;
    this.log('sse:event', { type: event.type, approvalId });

    if (event.type === 'approval.approved') {
      const payload = event.payload as Record<string, unknown> | null;
      const token = typeof payload?.['token'] === 'string' ? payload['token'] : '';
      if (!token) {
        this.log('sse:empty-token', { approvalId });
        // Leave gate in pendingGates so polling fallback or next SSE event can retry
        return;
      }
      this.pendingGates.delete(approvalId);
      this.cleanupAfterGate();
      entry.onApproved(token);
    } else if (event.type === 'approval.rejected') {
      this.pendingGates.delete(approvalId);
      this.cleanupAfterGate();
      entry.onTerminated(
        new MeshgateRejectedError(
          'Gate rejected by human approver',
          entry.gateInfo.intent,
          approvalId,
        ),
      );
    } else if (event.type === 'approval.expired') {
      this.pendingGates.delete(approvalId);
      this.cleanupAfterGate();
      entry.onTerminated(
        new MeshgateExpiredError('Gate expired before approval', entry.gateInfo.intent, approvalId),
      );
    }
  }

  private handleSseFallback(): void {
    this.log('sse:poll-fallback', {});
    this.sseClient = null;
    // Start polling for every still-pending gate
    for (const [approvalId, entry] of this.pendingGates) {
      void this.pollGate(approvalId, entry);
    }
  }

  private async pollGate(approvalId: string, entry: PendingGateEntry): Promise<void> {
    let delayIdx = 0;

    while (this.pendingGates.has(approvalId)) {
      const delay = POLL_DELAYS_MS[Math.min(delayIdx++, POLL_DELAYS_MS.length - 1)] ?? 30_000;
      await sleep(delay);

      if (!this.pendingGates.has(approvalId)) break;

      let status: ApprovalStatusResponse;
      try {
        status = await this.api.getApprovalStatus(approvalId);
      } catch (err) {
        // Network / 5xx errors are transient in polling mode; auth and missing
        // approval records are terminal and must not leave the caller hanging.
        if (err instanceof MeshgateNetworkError) {
          continue;
        }
        await this.adapter.delete(approvalId);
        this.pendingGates.delete(approvalId);
        this.cleanupAfterGate();

        const reason =
          err instanceof MeshgateOrphanedError && err.reason === 'not_found'
            ? 'gate_not_found'
            : 'verify_failed';
        const message =
          err instanceof MeshgateAuthError
            ? `Status polling is not authorized: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        await this.fireOrphanedHook({ ...entry.gateInfo, reason, message });
        entry.onTerminated(
          new MeshgateOrphanedError(
            message,
            entry.gateInfo.intent,
            approvalId,
            reason === 'gate_not_found' ? 'not_found' : undefined,
          ),
        );
        return;
      }

      if (!this.pendingGates.has(approvalId)) break;

      if (status.status === 'approved' && status.token) {
        this.pendingGates.delete(approvalId);
        this.cleanupAfterGate();
        entry.onApproved(status.token);
        return;
      } else if (status.status === 'rejected') {
        this.pendingGates.delete(approvalId);
        this.cleanupAfterGate();
        entry.onTerminated(
          new MeshgateRejectedError(
            'Gate rejected by human approver',
            entry.gateInfo.intent,
            approvalId,
          ),
        );
        return;
      } else if (status.status === 'expired') {
        this.pendingGates.delete(approvalId);
        this.cleanupAfterGate();
        entry.onTerminated(
          new MeshgateExpiredError(
            'Gate expired before approval',
            entry.gateInfo.intent,
            approvalId,
          ),
        );
        return;
      }
      // status === 'pending' → continue polling
    }
  }

  /** Stop SSE when there are no more pending gates. */
  private cleanupAfterGate(): void {
    if (this.pendingGates.size === 0 && this.sseClient) {
      this.sseClient.stop();
      this.sseClient = null;
      this.log('sse:stopped', {});
    }
  }

  // ─── Private: hooks ───────────────────────────────────────────────────────────

  private async fireHook(
    name: Exclude<keyof NonNullable<MeshgateConfig['hooks']>, 'onGateOrphaned'>,
    gateInfo: GateInfo,
  ): Promise<void> {
    const hook = this.hooks[name];
    if (hook) {
      await hook(gateInfo);
    }
  }

  private async fireOrphanedHook(event: GateOrphanedEvent): Promise<void> {
    const hook = this.hooks.onGateOrphaned;
    if (hook) {
      await hook(event);
    }
  }

  // ─── Private: debug logging ───────────────────────────────────────────────────

  private log(event: string, meta: Record<string, unknown>): void {
    // All internal SDK log entries are debug-level structural metadata.
    // SECURITY: never log args, keys, hashes, iv, ciphertext, apiKey, or masterSecret
    this.logger.debug(event, meta);
  }
}

// ─── Validation helpers ───────────────────────────────────────────────────────

/**
 * Throw MeshgateSerializationError if any value in `args` is not
 * JSON-serializable (Date, function, symbol, bigint, undefined, class instance).
 *
 * Called before any network calls or storage writes.
 */
export function validateSerializable(args: unknown[], intent: string): void {
  try {
    // Circular references throw here
    JSON.stringify(args);
  } catch (err) {
    throw new MeshgateSerializationError(
      `Function arguments are not JSON-serializable: ${String(err)}`,
      intent,
    );
  }
  // Check for types that serialize without error but are explicitly disallowed
  checkDeepSerializable(args, intent, 'args');
}

function checkDeepSerializable(value: unknown, intent: string, path: string): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return;
  }
  if (typeof value === 'undefined') {
    throw new MeshgateSerializationError(`Undefined value at ${path}`, intent);
  }
  if (typeof value === 'function') {
    throw new MeshgateSerializationError(`Function value at ${path}`, intent);
  }
  if (typeof value === 'symbol') {
    throw new MeshgateSerializationError(`Symbol value at ${path}`, intent);
  }
  if (typeof value === 'bigint') {
    throw new MeshgateSerializationError(`BigInt value at ${path}`, intent);
  }
  if (value instanceof Date) {
    throw new MeshgateSerializationError(
      `Date value at ${path} — convert to ISO string (date.toISOString())`,
      intent,
    );
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      checkDeepSerializable(value[i], intent, `${path}[${i}]`);
    }
    return;
  }
  if (typeof value === 'object') {
    // Reject class instances (non-plain objects)
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      const name = (value as { constructor?: { name?: string } }).constructor?.name ?? 'object';
      throw new MeshgateSerializationError(
        `Class instance (${name}) at ${path} — only plain objects are allowed`,
        intent,
      );
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      checkDeepSerializable(v, intent, `${path}.${k}`);
    }
  }
}

/**
 * Throw MeshgateSerializationError if intentArgs contains any value that is
 * not a flat string | number | boolean (nested objects, arrays, null, etc.).
 */
export function validateIntentArgsFlatness(
  intentArgs: Record<string, unknown>,
  intent: string,
): void {
  for (const [key, value] of Object.entries(intentArgs)) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new MeshgateSerializationError(
        `intentArgs["${key}"] must be string | number | boolean (got ${
          value === null ? 'null' : typeof value
        })`,
        intent,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
