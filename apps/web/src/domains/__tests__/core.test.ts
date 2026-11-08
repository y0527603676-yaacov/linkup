import { describe, expect, it } from "vitest";
import { attribute, commissionBaseMinor } from "../attribution/engine";
import { accrue, appendIdempotent, balances, resolveAgencySplit, reverseForRefund } from "../ledger/commission";
import { sign, verifySignature } from "../integrations/woocommerce/signature";
import type { NormalizedOrder } from "../integrations/types";

const order = (o: Partial<NormalizedOrder> = {}): NormalizedOrder => ({
  storeConnectionId: "sc1",
  externalOrderId: "1001",
  currency: "ILS",
  status: "processing",
  totalMinor: 50_000,
  taxMinor: 7_169, // 470/1.18 → tax ≈ 71.69
  shippingMinor: 3_000,
  shippingTaxMinor: 0,
  couponCodes: [],
  createdAt: new Date("2026-11-10T10:00:00Z"),
  ...o,
});

const terms = { creatorOrgId: "cr1", creatorCommissionBps: 1000, platformOrgId: "lk", platformFeeBps: 300 };

describe("attribution", () => {
  it("coupon beats click", () => {
    const r = attribute({
      order: order({ couponCodes: ["DANA10"] }),
      coupons: [{ code: "dana10", agreementVersionId: "av1", creatorOrgId: "cr1", active: true }],
      clicks: [{ clickedAt: new Date("2026-11-09T10:00:00Z"), agreementVersionId: "av2", creatorOrgId: "cr2", attributionWindowDays: 30 }],
    });
    expect(r.attributed && r.method).toBe("coupon");
    expect(r.attributed && r.creatorOrgId).toBe("cr1");
  });

  it("first applied coupon wins among multiple", () => {
    const r = attribute({
      order: order({ couponCodes: ["B", "A"] }),
      coupons: [
        { code: "a", agreementVersionId: "avA", creatorOrgId: "crA", active: true },
        { code: "b", agreementVersionId: "avB", creatorOrgId: "crB", active: true },
      ],
      clicks: [],
    });
    expect(r.attributed && r.creatorOrgId).toBe("crB");
  });

  it("last click within window wins; outside window ignored", () => {
    const r = attribute({
      order: order(),
      coupons: [],
      clicks: [
        { clickedAt: new Date("2026-10-01T00:00:00Z"), agreementVersionId: "old", creatorOrgId: "x", attributionWindowDays: 30 },
        { clickedAt: new Date("2026-11-01T00:00:00Z"), agreementVersionId: "mid", creatorOrgId: "y", attributionWindowDays: 30 },
        { clickedAt: new Date("2026-11-08T00:00:00Z"), agreementVersionId: "new", creatorOrgId: "z", attributionWindowDays: 30 },
      ],
    });
    expect(r.attributed && r.agreementVersionId).toBe("new");
  });

  it("cancelled order is not commissionable", () => {
    const r = attribute({ order: order({ status: "cancelled", couponCodes: ["a"] }), coupons: [{ code: "a", agreementVersionId: "v", creatorOrgId: "c", active: true }], clicks: [] });
    expect(r.attributed).toBe(false);
  });

  it("flags self-referral", () => {
    const r = attribute({
      order: order({ couponCodes: ["a"], customerEmailHash: "h1" }),
      coupons: [{ code: "a", agreementVersionId: "v", creatorOrgId: "c", active: true }],
      clicks: [],
      creatorEmailHashes: { c: "h1" },
    });
    expect(r.attributed && r.evidence.selfReferralSuspected).toBe(true);
  });

  it("commission base excludes tax and shipping (docs example)", () => {
    expect(commissionBaseMinor(order())).toBe(39_831);
  });
});

describe("ledger", () => {
  const base = 39_831;

  it("accrual matches BUSINESS_RULES example incl. agency split", () => {
    const e = accrue("at1", base, "ILS", { ...terms, agency: { agencyOrgId: "ag1", splitBps: 2000 } });
    const b = balances(e);
    expect(b.get("creator:cr1")).toBe(3_186);
    expect(b.get("agency:ag1")).toBe(797);
    expect(b.get("platform:lk")).toBe(1_195);
  });

  it("duplicate event does not double commission", () => {
    const first = accrue("at1", base, "ILS", terms);
    const ledger = appendIdempotent(appendIdempotent([], first), accrue("at1", base, "ILS", terms));
    expect(ledger).toHaveLength(first.length);
  });

  it("partial refund reduces proportionally", () => {
    let ledger = accrue("at1", base, "ILS", terms);
    ledger = appendIdempotent(ledger, reverseForRefund(ledger, "r1", Math.round(base / 2), base));
    expect(balances(ledger).get("creator:cr1")).toBe(1_991);
  });

  it("full refund reverses to zero, and repeated refund is idempotent", () => {
    let ledger = accrue("at1", base, "ILS", terms);
    ledger = appendIdempotent(ledger, reverseForRefund(ledger, "r1", base, base));
    ledger = appendIdempotent(ledger, reverseForRefund(ledger, "r1", base, base));
    const b = balances(ledger);
    expect(b.get("creator:cr1")).toBe(0);
    expect(b.get("platform:lk")).toBe(0);
  });

  it("refunds never push balance below zero", () => {
    let ledger = accrue("at1", base, "ILS", terms);
    ledger = appendIdempotent(ledger, reverseForRefund(ledger, "r1", base - 1, base));
    ledger = appendIdempotent(ledger, reverseForRefund(ledger, "r2", base - 1, base));
    expect(balances(ledger).get("creator:cr1")).toBe(0);
  });

  it("most specific approved agency split wins", () => {
    const rules = [
      { agencyOrgId: "ag", creatorOrgId: "c", campaignId: null, splitBps: 2000, approvedByCreator: true, isAgencyDefault: true },
      { agencyOrgId: "ag", creatorOrgId: "c", campaignId: null, splitBps: 1500, approvedByCreator: true },
      { agencyOrgId: "ag", creatorOrgId: "c", campaignId: "camp", splitBps: 1000, approvedByCreator: true },
      { agencyOrgId: "ag", creatorOrgId: "c", campaignId: "camp2", splitBps: 500, approvedByCreator: false },
    ];
    expect(resolveAgencySplit(rules, "c", "camp")?.splitBps).toBe(1000);
    expect(resolveAgencySplit(rules, "c", "camp2")?.splitBps).toBe(1500);
    expect(resolveAgencySplit(rules, "c", null)?.splitBps).toBe(1500);
  });
});

describe("webhook signature", () => {
  const body = '{"id":1}';
  it("accepts valid, rejects tampered, stale and replayed-old", () => {
    const now = 1_800_000_000;
    const sig = sign(body, now, "s3cret");
    expect(verifySignature(body, sig, now, "s3cret", now + 10)).toBe(true);
    expect(verifySignature('{"id":2}', sig, now, "s3cret", now)).toBe(false);
    expect(verifySignature(body, sig, now, "other", now)).toBe(false);
    expect(verifySignature(body, sig, now, "s3cret", now + 301)).toBe(false);
  });
});
