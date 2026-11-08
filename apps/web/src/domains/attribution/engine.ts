import type { NormalizedOrder } from "../integrations/types";

/** Pure attribution engine. See docs/BUSINESS_RULES.md. */

export interface CouponCandidate {
  code: string; // normalized lower-case
  agreementVersionId: string;
  creatorOrgId: string;
  active: boolean;
}

export interface ClickCandidate {
  clickedAt: Date;
  agreementVersionId: string;
  creatorOrgId: string;
  attributionWindowDays: number;
}

export type AttributionResult =
  | {
      attributed: true;
      method: "coupon" | "click";
      agreementVersionId: string;
      creatorOrgId: string;
      evidence: { winner: string; ignored: string[]; selfReferralSuspected: boolean };
    }
  | { attributed: false; reason: "no_evidence" | "order_not_commissionable"; evidence: { ignored: string[] } };

export interface AttributionInput {
  order: NormalizedOrder;
  coupons: CouponCandidate[]; // all LINKUP coupons for this store connection
  clicks: ClickCandidate[]; // clicks tied to this visitor/order
  creatorEmailHashes?: Record<string, string>; // creatorOrgId -> email hash
}

const DAY_MS = 86_400_000;

export function attribute(input: AttributionInput): AttributionResult {
  const { order } = input;
  if (order.status === "cancelled" || order.status === "failed") {
    return { attributed: false, reason: "order_not_commissionable", evidence: { ignored: [] } };
  }

  const byCode = new Map(input.coupons.filter((c) => c.active).map((c) => [c.code.toLowerCase(), c]));
  const matched = order.couponCodes.map((c) => byCode.get(c.toLowerCase())).filter((c): c is CouponCandidate => !!c);

  const selfRef = (creatorOrgId: string) =>
    !!order.customerEmailHash && input.creatorEmailHashes?.[creatorOrgId] === order.customerEmailHash;

  // Rule 2: a valid personal coupon wins; first applied coupon wins among several.
  const first = matched[0];
  if (first) {
    const ignored = [
      ...matched.slice(1).map((c) => `coupon:${c.code}`),
      ...input.clicks.map((c) => `click:${c.agreementVersionId}`),
    ];
    return {
      attributed: true,
      method: "coupon",
      agreementVersionId: first.agreementVersionId,
      creatorOrgId: first.creatorOrgId,
      evidence: { winner: `coupon:${first.code}`, ignored, selfReferralSuspected: selfRef(first.creatorOrgId) },
    };
  }

  // Rule 3: last eligible click inside its own attribution window.
  const orderTime = order.createdAt.getTime();
  const eligible = input.clicks
    .filter((c) => {
      const t = c.clickedAt.getTime();
      return t <= orderTime && orderTime - t <= c.attributionWindowDays * DAY_MS;
    })
    .sort((a, b) => b.clickedAt.getTime() - a.clickedAt.getTime());

  const last = eligible[0];
  if (last) {
    return {
      attributed: true,
      method: "click",
      agreementVersionId: last.agreementVersionId,
      creatorOrgId: last.creatorOrgId,
      evidence: {
        winner: `click:${last.clickedAt.toISOString()}`,
        ignored: eligible.slice(1).map((c) => `click:${c.clickedAt.toISOString()}`),
        selfReferralSuspected: selfRef(last.creatorOrgId),
      },
    };
  }

  return { attributed: false, reason: "no_evidence", evidence: { ignored: [] } };
}

/** Commission base: net of tax and shipping (default agreement setting). */
export function commissionBaseMinor(order: NormalizedOrder, base: "net_excl_tax_shipping" | "gross" = "net_excl_tax_shipping"): number {
  if (base === "gross") return order.totalMinor;
  const net = order.totalMinor - order.taxMinor - order.shippingMinor - order.shippingTaxMinor;
  return Math.max(0, net);
}
