/**
 * Base64 and Base64URL encoding/decoding helpers.
 *
 * No external dependencies. Uses globalThis.btoa/atob, which are available
 * in Node.js 18+, Cloudflare Workers, Vercel Edge Runtime, Deno, and browsers.
 *
 * Return types are explicitly Uint8Array<ArrayBuffer> (not Uint8Array<ArrayBufferLike>)
 * to satisfy the Web Crypto API's BufferSource requirements in TypeScript 5.5+.
 */

/** Encode a Uint8Array as a standard base64 string (with `+`, `/`, and `=` padding). */
export function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Decode a standard base64 string to a Uint8Array<ArrayBuffer>. */
export function base64Decode(str: string): Uint8Array<ArrayBuffer> {
  const binary = atob(str);
  const buf = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encode a Uint8Array as a base64url string (URL-safe, no padding).
 * Uses `-` instead of `+`, `_` instead of `/`, and omits `=` padding.
 */
export function base64urlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Decode a base64url string (with or without padding) to a Uint8Array<ArrayBuffer>.
 */
export function base64urlDecode(str: string): Uint8Array<ArrayBuffer> {
  // Restore standard base64 characters and re-add padding
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (padded.length % 4)) % 4;
  return base64Decode(padded + '='.repeat(padding));
}
