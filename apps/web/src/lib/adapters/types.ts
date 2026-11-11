/**
 * Universal Connect: the one order format LINKUP's engine accepts (public.ingest_order_event).
 * Every platform adapter only maps its own data to this shape; fees, attribution and the ledger never change per platform.
 */
export type NormalizedOrder = {
  id: string;
  status: "pending" | "processing" | "on-hold" | "completed" | "cancelled" | "refunded" | "failed";
  currency: string;
  total: number; tax: number; shipping: number; shipping_tax: number;   // minor units
  coupons: string[];
  ref: string;              // "CODE|unix-seconds" or ""
  email_hash: string;       // sha256(lower(trim(email))) or ""
  created_at: string;
  refunds: { id: string; amount: number }[];
};
export type NormalizedEvent = { event_id: string; type: string; occurred_at: string; order: NormalizedOrder };

/** What each platform adapter provides. Connection, product and coupon steps are added per platform as they are verified. */
export type PlatformAdapter = {
  platform: "woocommerce" | "shopify" | "wix" | "custom" | "manual";
  /** Verifies a webhook/report really comes from the platform (signature); never proves the sale itself. */
  verify(raw: string, headers: Record<string, string | undefined>, secret: string): Promise<boolean> | boolean;
  /** Maps one platform order payload to the normalized event, or null when it is not an order. */
  toEvent(payload: unknown, meta: { topic?: string }): NormalizedEvent | null;
};

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "HUF", "TWD", "UGX", "XAF", "XOF"]);
/** "123.45" (major units, string or number) → 12345 minor units, exact (no float drift). */
export function toMinor(v: unknown, currency: string): number {
  const s = String(v ?? "0").trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return 0;
  const dec = ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
  const [i, f = ""] = s.replace("-", "").split(".");
  const n = Number(i) * 10 ** dec + Number((f + "00").slice(0, dec) || 0) + (Number(f[dec] ?? 0) >= 5 ? 1 : 0);
  return s.startsWith("-") ? -n : n;
}

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
export const emailHash = (e: unknown) => (typeof e === "string" && e.includes("@") ? e.trim().toLowerCase() : "");
