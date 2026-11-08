// Shared by the Edge Function (Deno) and Node tests. WebCrypto only.
// Signature = hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`)) — mirrors the PHP plugin.
export const MAX_SKEW_SEC = 300;
const enc = new TextEncoder();

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifySignature(rawBody: string, signature: string, timestampSec: number, secret: string, nowSec: number): Promise<boolean> {
  if (!Number.isInteger(timestampSec) || Math.abs(nowSec - timestampSec) > MAX_SKEW_SEC) return false;
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  return safeEqual(await hmacHex(secret, `${timestampSec}.${rawBody}`), signature);
}

/** Accepts 32-hex or dashed uuid; returns dashed lower-case uuid or null. */
export function normalizeConnectionId(raw: string | null): string | null {
  const hex = (raw ?? "").toLowerCase().replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
