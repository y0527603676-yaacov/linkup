import type { DocumentProvider, PaymentProvider, Rpc } from "./types";

type Claimed = { charge_id: string; invoice_id: string; store_org_id: string; amount_minor: number; currency: string; attempt: number;
  idempotency_key: string; provider: string; token_ref: string };
type ClaimedRefund = { refund_id: string; charge_id: string; amount_minor: number; provider_ref: string; invoice_id: string; currency: string; provider: string };
type Invoice = { fees_minor: number; vat_minor: number; total_minor: number; credit_minor: number; currency: string; store_org_id: string };

export type RunReport = { scheduled: number; charged: number; failed: number; retries: number; documents: number; refunds: number; reminders: number; errors: string[] };

/**
 * One pass of the billing worker (cron). Idempotent: every charge carries a unique idempotency key; claims skip
 * rows another worker holds; documents are recorded once. With the master switch off, it schedules and charges nothing.
 */
export async function runBilling(rpc: Rpc, pay: PaymentProvider, docs: DocumentProvider): Promise<RunReport> {
  const getInvoice = (id: string) => rpc<Invoice>("billing_invoice_summary", { p_invoice: id });
  const r: RunReport = { scheduled: 0, charged: 0, failed: 0, retries: 0, documents: 0, refunds: 0, reminders: 0, errors: [] };
  r.scheduled = await rpc<number>("billing_schedule");
  const due = await rpc<Claimed[]>("billing_claim_due", { p_limit: 50 });
  for (const c of due) {
    if (c.provider !== pay.name) { r.errors.push(`provider_mismatch:${c.charge_id}`); continue; }
    let res;
    try {
      res = await pay.charge({ chargeId: c.charge_id, invoiceId: c.invoice_id, amountMinor: Number(c.amount_minor), currency: c.currency,
        tokenRef: c.token_ref, idempotencyKey: c.idempotency_key });
    } catch (e) {
      res = { ok: false as const, code: "provider_error", message: String((e as Error).message).slice(0, 200) };
    }
    const out = await rpc<{ result: string }>("billing_complete_charge", { p_charge: c.charge_id, p_success: res.ok,
      p_provider_ref: res.providerRef ?? null, p_failure_code: res.ok ? null : res.code, p_failure_message: res.ok ? null : res.message });
    if (out.result === "paid") {
      r.charged++;
      try {
        const inv = await getInvoice(c.invoice_id);
        const d = await docs.issueInvoiceReceipt({ invoiceId: c.invoice_id, storeOrgId: c.store_org_id, feeMinor: Number(inv.fees_minor),
          vatMinor: Number(inv.vat_minor), totalMinor: Number(inv.total_minor), offsetMinor: Number(inv.credit_minor), currency: inv.currency,
          paymentRef: res.ok ? res.providerRef : "" });
        await rpc("billing_record_document", { p_invoice: c.invoice_id, p_doc_type: d.docType, p_number: d.number, p_issued_on: d.issuedOn,
          p_amount_minor: d.amountMinor, p_vat_minor: d.vatMinor, p_provider: docs.name, p_note: null });
        r.documents++;
      } catch (e) {
        r.errors.push(`document:${c.invoice_id}:${(e as Error).message}`);   // shows in the exceptions queue as "document_missing"
      }
    } else if (out.result === "retry_scheduled") { r.retries++; } else { r.failed++; }
  }
  const refunds = await rpc<ClaimedRefund[]>("billing_claim_refunds", { p_limit: 50 });
  for (const f of refunds) {
    let res;
    try { res = await pay.refund({ refundId: f.refund_id, providerRef: f.provider_ref, amountMinor: Number(f.amount_minor), currency: f.currency }); }
    catch (e) { res = { ok: false as const, message: String((e as Error).message).slice(0, 200) }; }
    await rpc("billing_complete_refund", { p_refund: f.refund_id, p_success: res.ok, p_provider_ref: res.ok ? res.providerRef : null,
      p_failure_message: res.ok ? null : res.message });
    if (res.ok) {
      r.refunds++;
      try {
        const inv = await getInvoice(f.invoice_id);
        const d = await docs.issueCreditNote({ invoiceId: f.invoice_id, storeOrgId: inv.store_org_id, amountMinor: Number(f.amount_minor), currency: f.currency, reason: "refund" });
        await rpc("billing_record_document", { p_invoice: f.invoice_id, p_doc_type: d.docType, p_number: d.number, p_issued_on: d.issuedOn,
          p_amount_minor: d.amountMinor, p_vat_minor: d.vatMinor, p_provider: docs.name, p_note: `refund ${f.refund_id}` });
      } catch (e) { r.errors.push(`credit_note:${f.refund_id}:${(e as Error).message}`); }
    }
  }
  r.reminders = await rpc<number>("creator_payment_reminders");
  return r;
}
