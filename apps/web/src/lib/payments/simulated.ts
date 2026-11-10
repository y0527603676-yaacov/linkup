import type { DocumentProvider, PaymentProvider } from "./types";

/**
 * Deterministic stand-in for development and tests. No network, no money.
 * Tokens: "sim_ok_*" always succeed · "sim_decline_*" always decline · "sim_flaky_*" decline on attempt 1, then succeed.
 */
export function simulatedPayments(): PaymentProvider {
  let n = 0;
  return {
    name: "simulated",
    async createSetupSession({ storeOrgId, returnUrl }) {
      return { url: `/app/billing/simulated-checkout?org=${encodeURIComponent(storeOrgId)}&return=${encodeURIComponent(returnUrl)}` };
    },
    async charge(req) {
      const ref = `sim_ch_${++n}_${req.idempotencyKey}`;
      if (req.tokenRef.startsWith("sim_decline")) return { ok: false, providerRef: ref, code: "card_declined", message: "Card declined (simulated)" };
      if (req.tokenRef.startsWith("sim_flaky") && req.idempotencyKey.endsWith(":1")) return { ok: false, providerRef: ref, code: "insufficient_funds", message: "Insufficient funds (simulated)" };
      return { ok: true, providerRef: ref };
    },
    async refund(req) {
      return { ok: true, providerRef: `sim_rf_${req.refundId}` };
    },
    async parseWebhook(headers, rawBody) {
      if (headers.get("x-sim-signature") !== "valid") return null;
      const body = JSON.parse(rawBody) as { id: string; kind: string; payload: Record<string, unknown> };
      return { eventId: body.id, kind: body.kind, payload: body.payload };
    },
  };
}

export function simulatedDocuments(): DocumentProvider {
  let n = 1000;
  const today = () => new Date().toISOString().slice(0, 10);
  return {
    name: "simulated",
    async issueInvoiceReceipt({ feeMinor, vatMinor }) {
      return { docType: "tax_invoice_receipt", number: `SIM-${++n}`, issuedOn: today(), amountMinor: feeMinor, vatMinor };
    },
    async issueCreditNote({ amountMinor }) {
      return { docType: "credit_note", number: `SIM-CN-${++n}`, issuedOn: today(), amountMinor, vatMinor: 0 };
    },
  };
}
