/**
 * Money is always integer minor units (agorot/cents) + ISO currency.
 * Rates are basis points (bps): 10000 = 100%.
 */
export type Currency = string; // ISO 4217, e.g. "ILS"

export interface Money {
  readonly amountMinor: number;
  readonly currency: Currency;
}

export const BPS_DENOMINATOR = 10_000;

/** Round half away from zero on an integer division result. */
export function roundHalfUp(numerator: number, denominator: number): number {
  if (denominator === 0) throw new Error("division by zero");
  const sign = Math.sign(numerator) * Math.sign(denominator);
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  return sign * Math.floor((2 * n + d) / (2 * d));
}

export function applyBps(amountMinor: number, bps: number): number {
  assertInt(amountMinor, "amountMinor");
  assertInt(bps, "bps");
  if (bps < 0 || bps > BPS_DENOMINATOR) throw new Error(`bps out of range: ${bps}`);
  return roundHalfUp(amountMinor * bps, BPS_DENOMINATOR);
}

export function assertInt(n: number, name: string): void {
  if (!Number.isSafeInteger(n)) throw new Error(`${name} must be a safe integer, got ${n}`);
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new Error(`currency mismatch ${a.currency}/${b.currency}`);
}
