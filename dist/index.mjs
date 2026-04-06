import lockfile from 'proper-lockfile';

// src/adapters/noop-adapter.ts
var NoopAdapter = class {
  set() {
    return Promise.resolve();
  }
  get() {
    return Promise.resolve(null);
  }
  delete() {
    return Promise.resolve();
  }
  listKeys() {
    return Promise.resolve([]);
  }
};

// src/errors.ts
var MeshgateError = class extends Error {
  /** The intent name associated with the failed gate, if available. */
  intent;
  /** The Meshgate approval ID associated with the failed gate, if available. */
  approvalId;
  constructor(message, intent, approvalId) {
    super(message);
    this.name = new.target.name;
    this.intent = intent;
    this.approvalId = approvalId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
};
var MeshgateBlockedError = class extends MeshgateError {
};
var MeshgateRejectedError = class extends MeshgateError {
};
var MeshgateExpiredError = class extends MeshgateError {
};
var MeshgateOrphanedError = class extends MeshgateError {
  /** Machine-readable subcode indicating why the gate was orphaned. */
  reason;
  constructor(message, intent, approvalId, reason) {
    super(message, intent, approvalId);
    this.reason = reason;
  }
};
var MeshgateTamperError = class extends MeshgateError {
};
var MeshgateNetworkError = class extends MeshgateError {
};
var MeshgateConfigError = class extends MeshgateError {
};
var MeshgateSerializationError = class extends MeshgateError {
};
var MeshgateAuthError = class extends MeshgateError {
};

// src/adapters/fs-adapter.ts
async function getFsPromises() {
  try {
    return await import('fs/promises');
  } catch {
    throw new MeshgateConfigError(
      "FileSystemAdapter requires Node.js or Bun. Use CloudflareKVAdapter or NoopAdapter in edge runtimes."
    );
  }
}
var FileSystemAdapter = class {
  baseDir;
  dir;
  constructor(baseDir) {
    this.baseDir = baseDir ?? process.cwd();
    this.dir = `${this.baseDir}/.meshgate`;
  }
  keyPath(approvalId) {
    if (approvalId.includes("/") || approvalId.includes("\\") || approvalId.includes("..")) {
      throw new MeshgateConfigError(
        `Invalid approvalId "${approvalId}": must not contain /, \\, or ..`
      );
    }
    return `${this.dir}/${approvalId}.json`;
  }
  async set(approvalId, data) {
    const fs = await getFsPromises();
    await fs.mkdir(this.dir, { recursive: true });
    const file = this.keyPath(approvalId);
    await fs.writeFile(file, "", "utf-8");
    let release;
    try {
      release = await lockfile.lock(file, { stale: 5e3, retries: 3 });
      await fs.writeFile(file, data, "utf-8");
    } catch (err) {
      throw new MeshgateError(`Failed to write gate record: ${String(err)}`);
    } finally {
      if (release) await release();
    }
  }
  async get(approvalId) {
    const fs = await getFsPromises();
    try {
      return await fs.readFile(this.keyPath(approvalId), "utf-8");
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw new MeshgateError(`Failed to read gate record: ${String(err)}`);
    }
  }
  async delete(approvalId) {
    const fs = await getFsPromises();
    const file = this.keyPath(approvalId);
    let release;
    try {
      release = await lockfile.lock(file, { stale: 5e3, retries: { retries: 3, minTimeout: 50, maxTimeout: 500 } });
      await fs.unlink(file);
    } catch (err) {
      const code = err.code;
      if (code === "ENOENT") return;
      if (code === "ELOCKED") {
        try {
          await fs.access(file);
          throw new MeshgateError(`Failed to delete gate record: could not acquire lock after retries`);
        } catch (accessErr) {
          if (accessErr.code === "ENOENT") return;
          throw new MeshgateError(`Failed to delete gate record: ${String(err)}`);
        }
      }
      throw new MeshgateError(`Failed to delete gate record: ${String(err)}`);
    } finally {
      if (release) await release();
    }
  }
  async listKeys() {
    const fs = await getFsPromises();
    try {
      const entries = await fs.readdir(this.dir);
      return entries.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw new MeshgateError(`Failed to list gate records: ${String(err)}`);
    }
  }
};

// src/adapters/kv-adapter.ts
var KEY_PREFIX = "mg:";
var CloudflareKVAdapter = class {
  kv;
  constructor(kv) {
    this.kv = kv;
  }
  kvKey(approvalId) {
    return `${KEY_PREFIX}${approvalId}`;
  }
  set(approvalId, data) {
    return this.kv.put(this.kvKey(approvalId), data);
  }
  get(approvalId) {
    return this.kv.get(this.kvKey(approvalId));
  }
  delete(approvalId) {
    return this.kv.delete(this.kvKey(approvalId));
  }
  async listKeys() {
    const keys = [];
    let cursor;
    do {
      const result = await this.kv.list({ prefix: KEY_PREFIX, cursor });
      for (const { name } of result.keys) {
        keys.push(name.slice(KEY_PREFIX.length));
      }
      cursor = result.list_complete ? void 0 : result.cursor;
    } while (cursor !== void 0);
    return keys;
  }
};

// src/api/client.ts
var REQUEST_TIMEOUT_MS = 1e4;
var RETRY_DELAYS_MS = [0, 1e3, 2e3];
var MeshgateApiClient = class {
  baseUrl;
  headers;
  constructor(apiKey, baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    };
  }
  // ─── POST /v1/intent ───────────────────────────────────────────────────────
  async registerIntent(req) {
    return this.withRetry(() => this.post("/v1/intent", req, { retryOn503: true }));
  }
  // ─── GET /v1/approvals/:id/status ─────────────────────────────────────────
  getApprovalStatus(approvalId) {
    return this.get(
      `/v1/approvals/${encodeURIComponent(approvalId)}/status`
    );
  }
  // ─── POST /v1/verify-token ─────────────────────────────────────────────────
  verifyToken(req) {
    return this.withRetry(
      () => this.post("/v1/verify-token", req, { retryOn503: true })
    );
  }
  // ─── Internals ─────────────────────────────────────────────────────────────
  async get(path) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: this.headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (err) {
      throw new MeshgateNetworkError(`Network error: ${String(err)}`);
    }
    return this.parseResponse(res);
  }
  async post(path, body, opts) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (err) {
      throw new MeshgateNetworkError(`Network error: ${String(err)}`);
    }
    if (opts.retryOn503 && res.status === 503) {
      throw new RetryableError(`HTTP 503 from ${path}`);
    }
    return this.parseResponse(res);
  }
  async withRetry(fn) {
    let lastErr;
    for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
      const delay = RETRY_DELAYS_MS[i] ?? 0;
      if (delay > 0) {
        await sleep(delay);
      }
      try {
        return await fn();
      } catch (err) {
        if (err instanceof RetryableError || err instanceof MeshgateNetworkError) {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    if (lastErr instanceof MeshgateNetworkError) throw lastErr;
    throw new MeshgateNetworkError(
      `POST /v1/intent failed after ${RETRY_DELAYS_MS.length} attempts: ${String(lastErr)}`
    );
  }
  async parseResponse(res) {
    if (res.ok) {
      return res.json();
    }
    let body = {};
    try {
      body = await res.json();
    } catch {
    }
    const error = typeof body["error"] === "string" ? body["error"] : "";
    switch (res.status) {
      case 400:
        throw new MeshgateConfigError(`Bad request: ${error || res.statusText}`);
      case 401:
        throw new MeshgateAuthError(`Unauthorized: ${error || res.statusText}`);
      case 403:
        if (error === "intent_blocked") {
          throw new MeshgateBlockedError(`Intent blocked by policy`);
        }
        if (error === "token_exhausted") {
          throw new MeshgateOrphanedError(`Token already consumed`, void 0, void 0, "token_exhausted");
        }
        throw new MeshgateAuthError(`Forbidden: ${error || res.statusText}`);
      case 404:
        throw new MeshgateOrphanedError(`Resource not found: ${error || res.statusText}`, void 0, void 0, "not_found");
      case 422:
        throw new MeshgateConfigError(`Unprocessable entity: ${error || res.statusText}`);
      case 429: {
        const retryAfter = Number(res.headers.get("Retry-After") ?? "0");
        if (retryAfter > 0) await sleep(retryAfter * 1e3);
        throw new RetryableError(`HTTP 429 rate limit`);
      }
      case 503:
        throw new MeshgateNetworkError(`Service unavailable (503)`);
      default:
        throw new MeshgateNetworkError(`Unexpected HTTP ${res.status}: ${error || res.statusText}`);
    }
  }
};
var RetryableError = class extends Error {
};
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/utils/base64.ts
function base64Encode(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
function base64Decode(str) {
  const binary = atob(str);
  const buf = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
function base64urlEncode(bytes) {
  return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function base64urlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - padded.length % 4) % 4;
  return base64Decode(padded + "=".repeat(padding));
}

// src/utils/crypto.ts
var subtle = globalThis.crypto.subtle;
var HKDF_INFO = (() => {
  const raw = new TextEncoder().encode("meshgate-v1");
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  return new Uint8Array(buf);
})();
function generateGateNonce() {
  const buf = new ArrayBuffer(32);
  const bytes = new Uint8Array(buf);
  globalThis.crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}
async function deriveGateKey(masterSecret, gateNonce) {
  const masterRaw = new TextEncoder().encode(masterSecret);
  const masterBuf = new ArrayBuffer(masterRaw.length);
  new Uint8Array(masterBuf).set(masterRaw);
  const nonceBytes = base64urlDecode(gateNonce);
  const ikm = await subtle.importKey("raw", masterBuf, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: nonceBytes, info: HKDF_INFO },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    // non-extractable
    ["encrypt", "decrypt"]
  );
}
async function encryptGatePayload(key, payload) {
  const ivBuf = new ArrayBuffer(12);
  const iv = new Uint8Array(ivBuf);
  globalThis.crypto.getRandomValues(iv);
  const plainRaw = new TextEncoder().encode(JSON.stringify(payload));
  const plainBuf = new ArrayBuffer(plainRaw.length);
  new Uint8Array(plainBuf).set(plainRaw);
  const combined = await subtle.encrypt({ name: "AES-GCM", iv }, key, plainBuf);
  const bytes = new Uint8Array(combined);
  const ciphertext = bytes.slice(0, -16);
  const authTag = bytes.slice(-16);
  return {
    iv: base64Encode(iv),
    authTag: base64Encode(authTag),
    ciphertext: base64Encode(ciphertext)
  };
}
async function decryptGatePayload(key, iv, authTag, ciphertext) {
  const ivBytes = base64Decode(iv);
  const authTagBytes = base64Decode(authTag);
  const ciphertextBytes = base64Decode(ciphertext);
  const combinedBuf = new ArrayBuffer(ciphertextBytes.length + authTagBytes.length);
  const combined = new Uint8Array(combinedBuf);
  combined.set(ciphertextBytes);
  combined.set(authTagBytes, ciphertextBytes.length);
  const plaintext = await subtle.decrypt({ name: "AES-GCM", iv: ivBytes }, key, combined);
  return JSON.parse(new TextDecoder().decode(plaintext));
}
async function computePayloadHash(args) {
  const json = JSON.stringify(args);
  const raw = new TextEncoder().encode(json);
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  const hash = await subtle.digest("SHA-256", buf);
  return base64Encode(new Uint8Array(hash));
}

// src/utils/logger.ts
var LOG_LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };
function createLogger(level) {
  const minLevel = LOG_LEVEL_ORDER[level];
  function emit(msgLevel, event, meta = {}) {
    if (LOG_LEVEL_ORDER[msgLevel] < minLevel) return;
    if (msgLevel === "warn") {
      console.warn("[meshgate]", event, meta);
    } else if (msgLevel === "error") {
      console.error("[meshgate]", event, meta);
    } else {
      console.log("[meshgate]", event, meta);
    }
  }
  return {
    debug: (event, meta) => emit("debug", event, meta),
    info: (event, meta) => emit("info", event, meta),
    warn: (event, meta) => emit("warn", event, meta),
    error: (event, meta) => emit("error", event, meta)
  };
}

// src/utils/sse-client.ts
var DEFAULT_RECONNECT_DELAYS_MS = [0, 1e3, 2e3];
var SseClient = class {
  url;
  headers;
  opts;
  abortController = null;
  stopped = false;
  constructor(url, headers, opts) {
    this.url = url;
    this.headers = headers;
    this.opts = opts;
  }
  /** Start the SSE connection. Initiates the connect-and-reconnect loop. */
  start() {
    this.stopped = false;
    void this.connectLoop();
  }
  /** Stop the SSE connection permanently. No further reconnects will occur. */
  stop() {
    this.stopped = true;
    this.abortController?.abort();
    this.abortController = null;
  }
  // ─── Internal ─────────────────────────────────────────────────────────────
  async connectLoop() {
    const delays = this.opts.reconnectDelays ?? DEFAULT_RECONNECT_DELAYS_MS;
    const maxAttempts = delays.length + 1;
    let consecutiveFailures = 0;
    while (!this.stopped) {
      if (consecutiveFailures >= maxAttempts) {
        this.opts.onPollFallback();
        return;
      }
      const delayIndex = consecutiveFailures - 1;
      if (delayIndex >= 0 && delayIndex < delays.length) {
        const delay = delays[delayIndex] ?? 0;
        if (delay > 0) await sleep2(delay);
      }
      if (this.stopped) return;
      try {
        const readAtLeastOneChunk = await this.connect();
        if (readAtLeastOneChunk) {
          consecutiveFailures = 0;
        }
        consecutiveFailures++;
      } catch (err) {
        this.opts.onError?.(err);
        consecutiveFailures++;
      }
    }
  }
  async connect() {
    this.abortController = new AbortController();
    const res = await fetch(this.url, {
      method: "GET",
      headers: { ...this.headers, Accept: "text/event-stream" },
      signal: this.abortController.signal
    });
    if (!res.ok || !res.body) {
      throw new Error(`SSE connection failed: HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = {};
    let readAtLeastOneChunk = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        readAtLeastOneChunk = true;
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line === "") {
            this.dispatchEvent(currentEvent);
            currentEvent = {};
          } else if (line.startsWith("event:")) {
            currentEvent.type = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            const chunk2 = line.slice(5).trim();
            currentEvent.data = currentEvent.data !== void 0 ? `${currentEvent.data}
${chunk2}` : chunk2;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    return readAtLeastOneChunk;
  }
  dispatchEvent(raw) {
    if (!raw.type || !raw.data) return;
    let parsed;
    try {
      parsed = JSON.parse(raw.data);
    } catch {
      return;
    }
    if (!isObject(parsed) || typeof parsed["entityId"] !== "string") return;
    const event = {
      type: raw.type,
      entityId: parsed["entityId"],
      payload: parsed["payload"] ?? null
    };
    this.opts.onEvent(event);
  }
};
function isObject(v) {
  return typeof v === "object" && v !== null;
}
function sleep2(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/client.ts
var DEFAULT_BASE_URL = "https://api.meshgate.dev";
var POLL_DELAYS_MS = [1e3, 2e3, 4e3, 8e3, 16e3, 3e4];
var MeshgateClient = class {
  api;
  adapter;
  masterSecret;
  sseUrl;
  sseAuthHeader;
  hooks;
  logLevel;
  logger;
  sseReconnectDelays;
  /** intent name → registered handler, populated by guard(). */
  handlers = /* @__PURE__ */ new Map();
  /** approvalId → pending entry, populated by guard() and reconcile(). */
  pendingGates = /* @__PURE__ */ new Map();
  /** Shared SSE connection — started lazily on first gated response. */
  sseClient = null;
  /**
   * Deduplication guard: if a reconcile is already in progress, return the
   * same Promise rather than starting a second concurrent scan. Cleared via
   * .finally() when the run completes or errors.
   */
  reconcilePromise = null;
  /**
   * Resolves when the startup reconcile completes (or errors).
   * guard() awaits this before executing to ensure reconcile-registered
   * handlers are processed before new live calls proceed.
   */
  _reconcileReady;
  _resolveReconcileReady;
  /**
   * Tracks verify-token calls that are currently in-flight (or were in-flight
   * when a non-fatal error occurred). Used to distinguish:
   * - `token_exhausted_on_retry`: this instance had an in-flight call when the
   *   403 arrived (server burned the token, response was lost, now retrying)
   * - `token_already_used`: no prior in-flight call — another process burned it
   */
  _pendingVerify = /* @__PURE__ */ new Set();
  // ─── Constructor ─────────────────────────────────────────────────────────────
  constructor(config) {
    if (!config.apiKey?.trim()) {
      throw new MeshgateConfigError("apiKey is required and must not be empty");
    }
    if (!config.localEncryptionKey || config.localEncryptionKey.length < 32) {
      throw new MeshgateConfigError(
        "localEncryptionKey must be at least 32 characters. Generate one with: openssl rand -hex 32"
      );
    }
    this.masterSecret = config.localEncryptionKey;
    this.logLevel = config.debug ? "debug" : config.logLevel ?? "info";
    this.logger = createLogger(this.logLevel);
    this.hooks = config.hooks ?? {};
    this.sseReconnectDelays = config.sseReconnectDelays ?? [0, 1e3, 2e3];
    const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.api = new MeshgateApiClient(config.apiKey, baseUrl);
    this.sseUrl = `${baseUrl}/v1/events/stream`;
    this.sseAuthHeader = { Authorization: `Bearer ${config.apiKey}` };
    this.adapter = config.storageAdapter ?? new FileSystemAdapter();
    this._reconcileReady = new Promise((resolve) => {
      this._resolveReconcileReady = resolve;
    });
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
  guard(fn, options) {
    if (this.handlers.has(options.intent)) {
      throw new MeshgateConfigError(
        `Duplicate intent "${options.intent}": each intent must be unique per MeshgateClient instance`,
        options.intent
      );
    }
    this.handlers.set(options.intent, {
      fn
    });
    return (...args) => this._executeGuard(fn, options, args);
  }
  // ─── Private: startup reconcile ──────────────────────────────────────────────
  /**
   * Internal: scan the storage adapter for pending gates, resume approved ones,
   * clean up terminal states, and re-subscribe SSE for still-pending gates.
   *
   * Called automatically from the constructor. Deduplicates concurrent calls
   * by returning the in-progress Promise if one is already running.
   */
  _reconcile() {
    if (!this.reconcilePromise) {
      this.reconcilePromise = this._reconcileOnStartup().finally(() => {
        this.reconcilePromise = null;
      });
    }
    return this.reconcilePromise;
  }
  // ─── Private: guard execution ─────────────────────────────────────────────────
  async _executeGuard(fn, options, args) {
    await this._reconcileReady;
    validateSerializable(args, options.intent);
    let intentArgs;
    if (options.getIntentArgs) {
      try {
        intentArgs = options.getIntentArgs(...args);
      } catch (err) {
        throw new MeshgateSerializationError(
          `getIntentArgs threw an error: ${String(err)}`,
          options.intent
        );
      }
      validateIntentArgsFlatness(intentArgs, options.intent);
    }
    const payloadHash = await computePayloadHash(args);
    const gateNonce = generateGateNonce();
    this.log("intent:register", { intent: options.intent });
    const intentResponse = await this.api.registerIntent({
      intent: options.intent,
      intentArgs,
      payloadHash,
      gateNonce,
      expiresInSeconds: options.expiresInSeconds,
      description: options.description
    });
    if (intentResponse.outcome === "allowed") {
      this.log("intent:allowed", { intent: options.intent });
      return fn(...args);
    }
    if (intentResponse.outcome === "blocked") {
      this.log("intent:blocked", { intent: options.intent });
      throw new MeshgateBlockedError(
        `Intent "${options.intent}" was blocked by policy`,
        options.intent
      );
    }
    const { approvalId, expiresAt } = intentResponse;
    const gateInfo = { approvalId, intent: options.intent, expiresAt };
    this.log("intent:gated", { intent: options.intent, approvalId });
    const gateKey = await deriveGateKey(this.masterSecret, gateNonce);
    const { iv, authTag, ciphertext } = await encryptGatePayload(gateKey, {
      schemaVersion: "1",
      args
    });
    const record = {
      schemaVersion: "1",
      approvalId,
      intent: options.intent,
      expiresAt,
      iv,
      authTag,
      ciphertext,
      createdAt: Date.now()
    };
    await this.adapter.set(approvalId, JSON.stringify(record));
    this.ensureSseStarted();
    let token;
    try {
      token = await new Promise((resolve, reject) => {
        this.pendingGates.set(approvalId, {
          gateInfo,
          onApproved: resolve,
          onTerminated: reject
        });
      });
    } catch (err) {
      await this.adapter.delete(approvalId);
      this.cleanupAfterGate();
      if (err instanceof MeshgateRejectedError) {
        await this.fireHook("onGateRejected", gateInfo);
      } else if (err instanceof MeshgateExpiredError) {
        await this.fireHook("onGateExpired", gateInfo);
      } else {
        await this.fireOrphanedHook({
          ...gateInfo,
          reason: "verify_failed",
          message: err instanceof Error ? err.message : String(err)
        });
      }
      throw err;
    }
    const result = await this._verifyDecryptAndExecute(record, gateInfo, token, fn);
    await this.fireHook("onGateApproved", gateInfo);
    return result;
  }
  /**
   * Perform the mandatory phone-home verification, decrypt local state,
   * verify the payloadHash, and execute fn() with the decrypted args.
   *
   * This is called both from the live guard() flow and from reconcile().
   */
  async _verifyDecryptAndExecute(record, gateInfo, token, fn) {
    const wasAlreadyPending = this._pendingVerify.has(record.approvalId);
    this._pendingVerify.add(record.approvalId);
    let verifyRes;
    try {
      verifyRes = await this.api.verifyToken({ approvalId: record.approvalId, token });
      this._pendingVerify.delete(record.approvalId);
    } catch (err) {
      if (err instanceof MeshgateOrphanedError) {
        this._pendingVerify.delete(record.approvalId);
        await this.adapter.delete(record.approvalId);
        const reason = err.reason === "token_exhausted" ? wasAlreadyPending ? "token_exhausted_on_retry" : "token_already_used" : "gate_not_found";
        await this.fireOrphanedHook({ ...gateInfo, reason, message: err.message });
      } else {
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
        reason: "verify_failed",
        message: "verify-token response is missing gateNonce"
      });
      throw new MeshgateOrphanedError(
        "verify-token response is missing gateNonce",
        gateInfo.intent,
        record.approvalId
      );
    }
    const key = await deriveGateKey(this.masterSecret, resolvedNonce);
    let payload;
    try {
      payload = await decryptGatePayload(key, record.iv, record.authTag, record.ciphertext);
    } catch {
      await this.adapter.delete(record.approvalId);
      throw new MeshgateTamperError(
        "AES-GCM authentication failed \u2014 local ciphertext may have been tampered",
        gateInfo.intent,
        record.approvalId
      );
    }
    const cloudHash = verifyRes.context.payloadHash;
    if (cloudHash) {
      const recomputed = await computePayloadHash(payload.args);
      if (recomputed !== cloudHash) {
        await this.adapter.delete(record.approvalId);
        throw new MeshgateTamperError(
          "payloadHash mismatch \u2014 function arguments may have been tampered",
          gateInfo.intent,
          record.approvalId
        );
      }
    }
    await this.adapter.delete(record.approvalId);
    this.log("intent:executing", { intent: gateInfo.intent, approvalId: record.approvalId });
    return fn(...payload.args);
  }
  // ─── Private: reconcile ──────────────────────────────────────────────────────
  async _reconcileOnStartup() {
    const result = {
      resumed: [],
      rejected: [],
      expired: [],
      orphaned: [],
      pending: []
    };
    const keys = await this.adapter.listKeys();
    const approvedGates = [];
    const pendingGates = [];
    for (const approvalId of keys) {
      const raw = await this.adapter.get(approvalId);
      if (!raw) continue;
      let record;
      try {
        record = JSON.parse(raw);
      } catch {
        await this.adapter.delete(approvalId);
        continue;
      }
      if (record.schemaVersion !== "1" || !record.approvalId || !record.intent || !record.expiresAt || !record.iv || !record.authTag || !record.ciphertext) {
        await this.adapter.delete(approvalId);
        continue;
      }
      const gateInfo = {
        approvalId: record.approvalId,
        intent: record.intent,
        expiresAt: record.expiresAt
      };
      const expiryDate = new Date(record.expiresAt);
      if (isNaN(expiryDate.getTime()) || expiryDate < /* @__PURE__ */ new Date()) {
        await this.adapter.delete(approvalId);
        await this.fireHook("onGateExpired", gateInfo);
        result.expired.push(gateInfo);
        continue;
      }
      let status;
      try {
        status = await this.api.getApprovalStatus(approvalId);
      } catch {
        await this.adapter.delete(approvalId);
        await this.fireOrphanedHook({
          ...gateInfo,
          reason: "gate_not_found",
          message: "Approval record not found in cloud"
        });
        result.orphaned.push(gateInfo);
        continue;
      }
      if (status.status === "rejected") {
        await this.adapter.delete(approvalId);
        await this.fireHook("onGateRejected", gateInfo);
        result.rejected.push(gateInfo);
      } else if (status.status === "expired") {
        await this.adapter.delete(approvalId);
        await this.fireHook("onGateExpired", gateInfo);
        result.expired.push(gateInfo);
      } else if (status.status === "approved") {
        if (!status.token) {
          await this.adapter.delete(approvalId);
          await this.fireOrphanedHook({
            ...gateInfo,
            reason: "token_already_used",
            message: "Token already consumed by another process"
          });
          result.orphaned.push(gateInfo);
        } else {
          approvedGates.push({ record, gateInfo, status });
        }
      } else {
        pendingGates.push({ record, gateInfo, status });
      }
    }
    approvedGates.sort((a, b) => {
      const ta = a.status.resolvedAt ? new Date(a.status.resolvedAt).getTime() : 0;
      const tb = b.status.resolvedAt ? new Date(b.status.resolvedAt).getTime() : 0;
      return tb - ta;
    });
    pendingGates.sort((a, b) => (a.record.createdAt ?? 0) - (b.record.createdAt ?? 0));
    for (const { record, gateInfo, status } of approvedGates) {
      const resumed = await this._reconcileApproved(record, gateInfo, status.token);
      if (resumed) {
        result.resumed.push(gateInfo);
      } else {
        result.orphaned.push(gateInfo);
      }
    }
    for (const { record, gateInfo } of pendingGates) {
      this.ensureSseStarted();
      this.pendingGates.set(gateInfo.approvalId, {
        gateInfo,
        onApproved: (tok) => {
          void this._reconcileApproved(record, gateInfo, tok);
        },
        onTerminated: (err) => {
          void this._reconcileTerminated(gateInfo, err);
        }
      });
      result.pending.push(gateInfo);
    }
    return result;
  }
  /**
   * Verify-token, decrypt, look up handler, and execute for a gate approved
   * during reconcile(). Returns true if the handler executed successfully.
   */
  async _reconcileApproved(record, gateInfo, token) {
    const handler = this.handlers.get(record.intent);
    if (!handler) {
      await this.adapter.delete(record.approvalId);
      this.pendingGates.delete(record.approvalId);
      await this.fireOrphanedHook({
        ...gateInfo,
        reason: "gate_not_found",
        message: `No handler registered for intent "${record.intent}" \u2014 was it renamed or removed?`
      });
      return false;
    }
    try {
      await this._verifyDecryptAndExecute(
        record,
        gateInfo,
        token,
        async (...args) => {
          try {
            await handler.fn(...args);
          } catch {
          }
        }
      );
    } catch (err) {
      this.pendingGates.delete(record.approvalId);
      if (err instanceof MeshgateTamperError) {
        await this.fireOrphanedHook({
          ...gateInfo,
          reason: "decryption_failed",
          message: "Local encryption key may have been rotated. Existing gates cannot be decrypted."
        });
      }
      return false;
    }
    this.pendingGates.delete(record.approvalId);
    this.cleanupAfterGate();
    await this.fireHook("onGateApproved", gateInfo);
    return true;
  }
  /** Clean up a pending gate that reached a terminal state during reconcile. */
  async _reconcileTerminated(gateInfo, err) {
    await this.adapter.delete(gateInfo.approvalId);
    this.pendingGates.delete(gateInfo.approvalId);
    this.cleanupAfterGate();
    if (err instanceof MeshgateRejectedError) {
      await this.fireHook("onGateRejected", gateInfo);
    } else if (err instanceof MeshgateExpiredError) {
      await this.fireHook("onGateExpired", gateInfo);
    } else {
      await this.fireOrphanedHook({
        ...gateInfo,
        reason: "verify_failed",
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }
  // ─── Private: SSE ────────────────────────────────────────────────────────────
  ensureSseStarted() {
    if (this.sseClient) return;
    this.sseClient = new SseClient(this.sseUrl, this.sseAuthHeader, {
      onEvent: (event) => this.handleSseEvent(event),
      onPollFallback: () => this.handleSseFallback(),
      onError: (err) => this.log("sse:error", { error: String(err) }),
      reconnectDelays: this.sseReconnectDelays
    });
    this.sseClient.start();
    this.log("sse:started", {});
  }
  handleSseEvent(event) {
    const entry = this.pendingGates.get(event.entityId);
    if (!entry) return;
    const approvalId = event.entityId;
    this.log("sse:event", { type: event.type, approvalId });
    if (event.type === "approval.approved") {
      const payload = event.payload;
      const token = typeof payload?.["token"] === "string" ? payload["token"] : "";
      if (!token) {
        this.log("sse:empty-token", { approvalId });
        return;
      }
      this.pendingGates.delete(approvalId);
      this.cleanupAfterGate();
      entry.onApproved(token);
    } else if (event.type === "approval.rejected") {
      this.pendingGates.delete(approvalId);
      this.cleanupAfterGate();
      entry.onTerminated(
        new MeshgateRejectedError(
          "Gate rejected by human approver",
          entry.gateInfo.intent,
          approvalId
        )
      );
    } else if (event.type === "approval.expired") {
      this.pendingGates.delete(approvalId);
      this.cleanupAfterGate();
      entry.onTerminated(
        new MeshgateExpiredError(
          "Gate expired before approval",
          entry.gateInfo.intent,
          approvalId
        )
      );
    }
  }
  handleSseFallback() {
    this.log("sse:poll-fallback", {});
    this.sseClient = null;
    for (const [approvalId, entry] of this.pendingGates) {
      void this.pollGate(approvalId, entry);
    }
  }
  async pollGate(approvalId, entry) {
    let delayIdx = 0;
    while (this.pendingGates.has(approvalId)) {
      const delay = POLL_DELAYS_MS[Math.min(delayIdx++, POLL_DELAYS_MS.length - 1)] ?? 3e4;
      await sleep3(delay);
      if (!this.pendingGates.has(approvalId)) break;
      let status;
      try {
        status = await this.api.getApprovalStatus(approvalId);
      } catch {
        continue;
      }
      if (!this.pendingGates.has(approvalId)) break;
      if (status.status === "approved" && status.token) {
        this.pendingGates.delete(approvalId);
        this.cleanupAfterGate();
        entry.onApproved(status.token);
        return;
      } else if (status.status === "rejected") {
        this.pendingGates.delete(approvalId);
        this.cleanupAfterGate();
        entry.onTerminated(
          new MeshgateRejectedError(
            "Gate rejected by human approver",
            entry.gateInfo.intent,
            approvalId
          )
        );
        return;
      } else if (status.status === "expired") {
        this.pendingGates.delete(approvalId);
        this.cleanupAfterGate();
        entry.onTerminated(
          new MeshgateExpiredError(
            "Gate expired before approval",
            entry.gateInfo.intent,
            approvalId
          )
        );
        return;
      }
    }
  }
  /** Stop SSE when there are no more pending gates. */
  cleanupAfterGate() {
    if (this.pendingGates.size === 0 && this.sseClient) {
      this.sseClient.stop();
      this.sseClient = null;
      this.log("sse:stopped", {});
    }
  }
  // ─── Private: hooks ───────────────────────────────────────────────────────────
  async fireHook(name, gateInfo) {
    const hook = this.hooks[name];
    if (hook) {
      await hook(gateInfo);
    }
  }
  async fireOrphanedHook(event) {
    const hook = this.hooks.onGateOrphaned;
    if (hook) {
      await hook(event);
    }
  }
  // ─── Private: debug logging ───────────────────────────────────────────────────
  log(event, meta) {
    this.logger.debug(event, meta);
  }
};
function validateSerializable(args, intent) {
  try {
    JSON.stringify(args);
  } catch (err) {
    throw new MeshgateSerializationError(
      `Function arguments are not JSON-serializable: ${String(err)}`,
      intent
    );
  }
  checkDeepSerializable(args, intent, "args");
}
function checkDeepSerializable(value, intent, path) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "undefined") {
    throw new MeshgateSerializationError(`Undefined value at ${path}`, intent);
  }
  if (typeof value === "function") {
    throw new MeshgateSerializationError(`Function value at ${path}`, intent);
  }
  if (typeof value === "symbol") {
    throw new MeshgateSerializationError(`Symbol value at ${path}`, intent);
  }
  if (typeof value === "bigint") {
    throw new MeshgateSerializationError(`BigInt value at ${path}`, intent);
  }
  if (value instanceof Date) {
    throw new MeshgateSerializationError(
      `Date value at ${path} \u2014 convert to ISO string (date.toISOString())`,
      intent
    );
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      checkDeepSerializable(value[i], intent, `${path}[${i}]`);
    }
    return;
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const name = value.constructor?.name ?? "object";
      throw new MeshgateSerializationError(
        `Class instance (${name}) at ${path} \u2014 only plain objects are allowed`,
        intent
      );
    }
    for (const [k, v] of Object.entries(value)) {
      checkDeepSerializable(v, intent, `${path}.${k}`);
    }
  }
}
function validateIntentArgsFlatness(intentArgs, intent) {
  for (const [key, value] of Object.entries(intentArgs)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new MeshgateSerializationError(
        `intentArgs["${key}"] must be string | number | boolean (got ${value === null ? "null" : typeof value})`,
        intent
      );
    }
  }
}
function sleep3(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { CloudflareKVAdapter, FileSystemAdapter, MeshgateAuthError, MeshgateBlockedError, MeshgateClient, MeshgateConfigError, MeshgateError, MeshgateExpiredError, MeshgateNetworkError, MeshgateOrphanedError, MeshgateRejectedError, MeshgateSerializationError, MeshgateTamperError, NoopAdapter };
//# sourceMappingURL=index.mjs.map
//# sourceMappingURL=index.mjs.map