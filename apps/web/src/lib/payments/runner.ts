import type { DocumentProvider, IssuedDocument, PaymentProvider, Rpc } from "./types";

type Claimed = { charge_id: string; invoice_id: string; store_org_id: string; amount_minor: number; currency: string; attempt: number;
  idempotency_key: string; provider: string; token_ref: string };
type ClaimedRefund = { refund_id: string; charge_id: string; amount_minor: number; provider_ref: string; invoice_id: string; currency: string; provider: string };
type Invoice = { fees_minor: number; vat_minor: number; total_minor: number; credit_minor: number; currency: string; store_org_id: string };

export type RunReport = { scheduled: number; charged: number; failed: number; retries: number; unknown: number; resolved: number; documents: number;
  refunds: number; reminders: number; errors: string[] };

/**
 * One pass of the billing worker (cron). Idempotent: every charge carries a unique idempotency key; claims skip
 * rows another worker holds; documents are recorded once. With the master switch off, it schedules and charges nothing.
 */
export async function runBilling(rpc: Rpc, pay: PaymentProvider, docs: DocumentProvider): Promise<RunReport> {
  const getInvoice = (id: string) => rpc<Invoice>("billing_invoice_summary", { p_invoice: id });
  const r: RunReport = { scheduled: 0, charged: 0, failed: 0, retries: 0, unknown: 0, resolved: 0, documents: 0, refunds: 0, reminders: 0, errors: [] };
  const recordDoc = async (invoiceId: string, storeOrgId: string, providerRef: string, given?: IssuedDocument) => {
    try {
      const inv = await getInvoice(invoiceId);
      // Document issued together with the charge (Morning) → record it; otherwise ask the document provider.
      const d = given ?? await docs.issueInvoiceReceipt({ invoiceId, storeOrgId, feeMinor: Number(inv.fees_minor),
        vatMinor: Number(inv.vat_minor), totalMinor: Number(inv.total_minor), offsetMinor: Number(inv.credit_minor), currency: inv.currency, paymentRef: providerRef });
      await rpc("billing_record_document", { p_invoice: invoiceId, p_doc_type: d.docType, p_number: d.number, p_issued_on: d.issuedOn,
        p_amount_minor: d.amountMinor, p_vat_minor: d.vatMinor, p_provider: docs.name, p_note: d.providerDocId ? `provider doc ${d.providerDocId}` : null });
      r.documents++;
    } catch (e) {
      r.errors.push(`document:${invoiceId}:${(e as Error).message}`);   // shows in the exceptions queue as "document_missing"
    }
  };
  // 1. Charges left mid-call by a stopped worker become "unknown" — never charged again blindly.
  await rpc<number>("billing_sweep_stale", { p_minutes: 15 });
  // 2. Unknown results: ask the provider. Found → paid. Not found → stays unknown (could be a delay) for the owner.
  for (const u of await rpc<{ charge_id: string; invoice_id: string; provider: string }[]>("billing_unknown_open")) {
    if (u.provider !== pay.name || !pay.findCharge) continue;
    try {
      const found = await pay.findCharge(u.invoice_id);
      if (!found) continue;
      const out = await rpc<{ result: string }>("billing_resolve_unknown", { p_charge: u.charge_id, p_outcome: "succeeded", p_provider_ref: found.providerRef,
        p_source: "provider_query", p_note: null });
      r.resolved++;
      if (out.result === "paid") await recordDoc(u.invoice_id, (await getInvoice(u.invoice_id)).store_org_id, found.providerRef, found.document);
    } catch (e) { r.errors.push(`lookup:${u.charge_id}:${(e as Error).message}`); }
  }
  r.scheduled = await rpc<number>("billing_schedule");
  const due = await rpc<Claimed[]>("billing_claim_due", { p_limit: 50 });
  for (const c of due) {
    if (c.provider !== pay.name) { r.errors.push(`provider_mismatch:${c.charge_id}`); continue; }
    let res: Awaited<ReturnType<PaymentProvider["charge"]>>;
    try {
      // A later attempt first checks whether an earlier one already went through (lost response) → never charge twice.
      const earlier = c.attempt > 1 && pay.findCharge ? await pay.findCharge(c.invoice_id) : null;
      if (earlier) {
        res = { ok: true, providerRef: earlier.providerRef, document: earlier.document };
      } else {
        const inv = await getInvoice(c.invoice_id);
        res = await pay.charge({ chargeId: c.charge_id, invoiceId: c.invoice_id, amountMinor: Number(c.amount_minor), currency: c.currency,
          tokenRef: c.token_ref, idempotencyKey: c.idempotency_key,
          invoice: { feeMinor: Number(inv.fees_minor), vatMinor: Number(inv.vat_minor), offsetMinor: Number(inv.credit_minor) } });
      }
    } catch (e) {
      // No answer = unknown result (the provider may have charged). Never treated as a decline.
      res = { ok: false as const, code: "no_response", message: String((e as Error).message).slice(0, 200), unknown: true };
    }
    if (!res.ok && res.unknown) {
      await rpc("billing_mark_unknown", { p_charge: c.charge_id, p_detail: `${res.code}: ${res.message}` });
      r.unknown++;
      continue;
    }
    const out = await rpc<{ result: string }>("billing_complete_charge", { p_charge: c.charge_id, p_success: res.ok,
      p_provider_ref: res.providerRef ?? null, p_failure_code: res.ok ? null : res.code, p_failure_message: res.ok ? null : res.message });
    if (out.result === "paid") {
      r.charged++;
      await recordDoc(c.invoice_id, c.store_org_id, res.ok ? res.providerRef : "", res.ok ? res.document : undefined);
    } else if (out.result === "retry_scheduled") { r.retries++; }
    else if (out.result.startsWith("alert")) { r.errors.push(`alert:${c.invoice_id}:${out.result}`); }
    else { r.failed++; }
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
