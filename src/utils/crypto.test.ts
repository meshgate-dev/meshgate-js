import { describe, expect, it } from 'vitest';

import {
  computePayloadHash,
  decryptGatePayload,
  deriveGateKey,
  encryptGatePayload,
  generateGateNonce,
} from './crypto.js';

describe('generateGateNonce', () => {
  it('returns a base64url string of 32 bytes (43 chars no padding)', () => {
    const nonce = generateGateNonce();
    // 32 bytes base64url-encoded without padding = ceil(32*4/3) = 43 chars
    expect(nonce).toHaveLength(43);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces unique values on each call', () => {
    const n1 = generateGateNonce();
    const n2 = generateGateNonce();
    expect(n1).not.toBe(n2);
  });
});

describe('deriveGateKey', () => {
  const secret = 'a'.repeat(32); // 32-char secret (min valid length)
  const nonce1 = generateGateNonce();
  const nonce2 = generateGateNonce();

  it('returns a CryptoKey', async () => {
    const key = await deriveGateKey(secret, nonce1);
    expect(key).toBeInstanceOf(CryptoKey);
    expect(key.algorithm.name).toBe('AES-GCM');
    expect(key.extractable).toBe(false);
  });

  it('is deterministic — same inputs produce a key that round-trips identically', async () => {
    // We can't compare CryptoKey objects directly, but we can verify that two
    // keys derived from the same inputs produce the same ciphertext by
    // cross-decrypting: encrypt with key1, decrypt with key2 — must succeed.
    const key1 = await deriveGateKey(secret, nonce1);
    const key2 = await deriveGateKey(secret, nonce1); // same nonce
    const payload = { schemaVersion: '1' as const, args: ['test', 42] };
    const encrypted = await encryptGatePayload(key1, payload);
    const decrypted = await decryptGatePayload(
      key2,
      encrypted.iv,
      encrypted.authTag,
      encrypted.ciphertext,
    );
    expect(decrypted).toEqual(payload);
  });

  it('different nonces produce different keys (cross-decrypt fails)', async () => {
    const key1 = await deriveGateKey(secret, nonce1);
    const key2 = await deriveGateKey(secret, nonce2);
    const payload = { schemaVersion: '1' as const, args: ['test'] };
    const encrypted = await encryptGatePayload(key1, payload);
    await expect(
      decryptGatePayload(key2, encrypted.iv, encrypted.authTag, encrypted.ciphertext),
    ).rejects.toThrow();
  });
});

describe('encryptGatePayload / decryptGatePayload', () => {
  const secret = 'super-secret-key-for-testing-only-32chars';
  const nonce = generateGateNonce();

  it('round-trips a GatePayload correctly', async () => {
    const key = await deriveGateKey(secret, nonce);
    const payload = {
      schemaVersion: '1' as const,
      args: ['cust_123', 750, true, null, { nested: 'allowed in args' }],
    };
    const { iv, authTag, ciphertext } = await encryptGatePayload(key, payload);
    const decrypted = await decryptGatePayload(key, iv, authTag, ciphertext);
    expect(decrypted).toEqual(payload);
  });

  it('each encryption produces a different iv and ciphertext', async () => {
    const key = await deriveGateKey(secret, nonce);
    const payload = { schemaVersion: '1' as const, args: ['same'] };
    const enc1 = await encryptGatePayload(key, payload);
    const enc2 = await encryptGatePayload(key, payload);
    expect(enc1.iv).not.toBe(enc2.iv);
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
  });

  it('returns base64-encoded strings for iv, authTag, ciphertext', async () => {
    const key = await deriveGateKey(secret, nonce);
    const { iv, authTag, ciphertext } = await encryptGatePayload(key, {
      schemaVersion: '1',
      args: [],
    });
    expect(iv).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(authTag).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(ciphertext).toMatch(/^[A-Za-z0-9+/]+=*$/);
    // iv = 12 bytes → 16 base64 chars
    expect(iv).toHaveLength(16);
    // authTag = 16 bytes → 24 base64 chars
    expect(authTag).toHaveLength(24);
  });

  it('tamper detection: modifying ciphertext throws on decrypt', async () => {
    const key = await deriveGateKey(secret, nonce);
    const { iv, authTag, ciphertext } = await encryptGatePayload(key, {
      schemaVersion: '1',
      args: ['sensitive'],
    });
    // Flip a bit in the ciphertext by modifying the last character
    const tampered = ciphertext.slice(0, -4) + 'AAAA';
    await expect(decryptGatePayload(key, iv, authTag, tampered)).rejects.toThrow();
  });

  it('tamper detection: modifying authTag throws on decrypt', async () => {
    const key = await deriveGateKey(secret, nonce);
    const { iv, ciphertext } = await encryptGatePayload(key, {
      schemaVersion: '1',
      args: ['sensitive'],
    });
    // Replace with a different auth tag
    const fakeAuthTag = 'AAAAAAAAAAAAAAAAAAAAAA=='; // 16 bytes of 0x00
    await expect(decryptGatePayload(key, iv, fakeAuthTag, ciphertext)).rejects.toThrow();
  });
});

describe('computePayloadHash', () => {
  it('returns a base64-encoded SHA-256 hash (44 chars)', async () => {
    const hash = await computePayloadHash(['cust_123', 750]);
    // SHA-256 = 32 bytes → 44 base64 chars (with padding)
    expect(hash).toHaveLength(44);
    expect(hash).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('is deterministic — same args always produce the same hash', async () => {
    const h1 = await computePayloadHash(['cust_123', 750]);
    const h2 = await computePayloadHash(['cust_123', 750]);
    expect(h1).toBe(h2);
  });

  it('is sensitive to argument changes', async () => {
    const h1 = await computePayloadHash(['cust_123', 750]);
    const h2 = await computePayloadHash(['cust_123', 751]);
    const h3 = await computePayloadHash(['cust_456', 750]);
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
  });

  it('is sensitive to argument order', async () => {
    const h1 = await computePayloadHash([1, 2]);
    const h2 = await computePayloadHash([2, 1]);
    expect(h1).not.toBe(h2);
  });

  it('matches independently computed SHA-256 of JSON.stringify(args)', async () => {
    // Independent verification: compute SHA-256 via subtle.digest directly
    const args = ['a', 1];
    const json = JSON.stringify(args); // '["a",1]'
    const bytes = new TextEncoder().encode(json);
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    // Convert to base64 manually
    const hashBytes = new Uint8Array(hashBuffer);
    let binary = '';
    for (const b of hashBytes) binary += String.fromCharCode(b);
    const expected = btoa(binary);

    const actual = await computePayloadHash(args);
    expect(actual).toBe(expected);
  });
});
