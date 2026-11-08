import { applyBps, assertInt, roundHalfUp } from "../../lib/money";

/**
 * Append-only commission ledger logic (pure). Produces entries; never mutates.
 * Corrections are compensating entries (reversal / adjustment).
 */
export type PartyRole = "creator" | "agency" | "platform";
export type EntryType = "accrual" | "reversal" | "adjustment";

export interface LedgerEntry {
  idempotencyKey: string;
  attributionId: string;
  partyOrgId: string;
  partyRole: PartyRole;
  entryType: EntryType;
  amountMinor: number; // signed
  currency: string;
}

export interface Terms {
  creatorOrgId: string;
  creatorCommissionBps: number;
  platformOrgId: string;
  platformFeeBps: number;
  agency?: { agencyOrgId: string; splitBps: number }; // portion OF creator commission
}

export interface AgencySplitRule {
  agencyOrgId: string;
  creatorOrgId: string;
  campaignId: string | null; // null = creator-level
  splitBps: number;
  approvedByCreator: boolean;
  isAgencyDefault?: boolean;
}

/** Most specific approved rule wins: campaign > creator > agency default. */
export function resolveAgencySplit(rules: AgencySplitRule[], creatorOrgId: string, campaignId: string | null): AgencySplitRule | undefined {
  const approved = rules.filter((r) => r.approvedByCreator);
  return (
    (campaignId ? approved.find((r) => r.creatorOrgId === creatorOrgId && r.campaignId === campaignId) : undefined) ??
    approved.find((r) => r.creatorOrgId === creatorOrgId && r.campaignId === null && !r.isAgencyDefault) ??
    approved.find((r) => r.isAgencyDefault)
  );
}

export function accrue(attributionId: string, baseMinor: number, currency: string, t: Terms): LedgerEntry[] {
  assertInt(baseMinor, "baseMinor");
  const creatorGross = applyBps(baseMinor, t.creatorCommissionBps);
  const agencyShare = t.agency ? applyBps(creatorGross, t.agency.splitBps) : 0;
  const platform = applyBps(baseMinor, t.platformFeeBps);
  const key = (role: string) => `accrual:${attributionId}:${role}`;

  const entries: LedgerEntry[] = [
    { idempotencyKey: key("creator"), attributionId, partyOrgId: t.creatorOrgId, partyRole: "creator", entryType: "accrual", amountMinor: creatorGross - agencyShare, currency },
  ];
  if (t.agency) {
    entries.push({ idempotencyKey: key("agency"), attributionId, partyOrgId: t.agency.agencyOrgId, partyRole: "agency", entryType: "accrual", amountMinor: agencyShare, currency });
  }
  entries.push({ idempotencyKey: key("platform"), attributionId, partyOrgId: t.platformOrgId, partyRole: "platform", entryType: "accrual", amountMinor: platform, currency });
  return entries;
}

/** Balance per party from existing entries. */
export function balances(entries: LedgerEntry[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entries) m.set(`${e.partyRole}:${e.partyOrgId}`, (m.get(`${e.partyRole}:${e.partyOrgId}`) ?? 0) + e.amountMinor);
  return m;
}

/**
 * Refund of `refundMinor` out of original commission base `baseMinor`.
 * Reverses proportionally, never below zero remaining balance per party.
 */
export function reverseForRefund(
  existing: LedgerEntry[],
  refundId: string,
  refundMinor: number,
  baseMinor: number,
): LedgerEntry[] {
  assertInt(refundMinor, "refundMinor");
  if (existing.length === 0 || baseMinor <= 0) return [];
  const accruals = existing.filter((e) => e.entryType === "accrual");
  const bal = balances(existing);
  const full = refundMinor >= baseMinor;

  return accruals.flatMap((a) => {
    const k = `${a.partyRole}:${a.partyOrgId}`;
    const remaining = bal.get(k) ?? 0;
    if (remaining <= 0) return [];
    const proportional = full ? remaining : roundHalfUp(a.amountMinor * refundMinor, baseMinor);
    const amount = Math.min(proportional, remaining);
    if (amount === 0) return [];
    return [{
      idempotencyKey: `reversal:${refundId}:${a.partyRole}:${a.partyOrgId}`,
      attributionId: a.attributionId,
      partyOrgId: a.partyOrgId,
      partyRole: a.partyRole,
      entryType: "reversal" as const,
      amountMinor: -amount,
      currency: a.currency,
    }];
  });
}

/** Merge new entries into the ledger, ignoring duplicate idempotency keys. */
export function appendIdempotent(ledger: LedgerEntry[], incoming: LedgerEntry[]): LedgerEntry[] {
  const seen = new Set(ledger.map((e) => e.idempotencyKey));
  const out = [...ledger];
  for (const e of incoming) {
    if (seen.has(e.idempotencyKey)) continue;
    seen.add(e.idempotencyKey);
    out.push(e);
  }
  return out;
}
