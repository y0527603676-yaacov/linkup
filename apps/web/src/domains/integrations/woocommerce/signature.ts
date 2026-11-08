import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_SKEW_SEC = 300;

/** Signature = hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`)). Mirrors the PHP plugin. */
export function sign(rawBody: string, timestampSec: number, secret: string): string {
  return createHmac("sha256", secret).update(`${timestampSec}.${rawBody}`).digest("hex");
}

export function verifySignature(rawBody: string, signature: string, timestampSec: number, secret: string, nowSec: number): boolean {
  if (!Number.isInteger(timestampSec) || Math.abs(nowSec - timestampSec) > MAX_SKEW_SEC) return false;
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(sign(rawBody, timestampSec, secret), "hex");
  const given = Buffer.from(signature, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
