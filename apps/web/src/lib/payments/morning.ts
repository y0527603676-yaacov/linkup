import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChargeResult, DocumentProvider, IssuedDocument, PaymentProvider } from "./types";

/**
 * Morning (Green Invoice) with its built-in clearing (Grow). Built ONLY on what Morning's official OpenAPI reference
 * (developers.morning.co, "morning API Documentation" v2.0.0) and help centre document. NOT CONNECTED: without
 * credentials in server env every call throws, and BILLING_PROVIDER stays "simulated".
 *
 * Verified in the documentation (used here):
 *  - OAuth 2.0 client credentials: POST {idp}/idp/v1/oauth/token → accessToken, valid 1 hour. Separate keys per environment.
 *  - Base URLs: production https://api.greeninvoice.co.il/api/v1 · sandbox https://sandbox.d.greeninvoice.co.il/api/v1
 *  - POST /payments/tokens/search (saved cards, filter externalKey = Morning client id)
 *  - POST /payments/tokens/{id}/charge → charges a saved card AND returns the created document (type 320 = tax
 *    invoice-receipt): id, number, url, vatRate, transactionId. One call = payment + its tax document.
 *  - POST /documents/search (filter by description) → used to find a charge whose response was lost.
 *  - Webhooks (set in the Morning UI): events document/created, payment/received; header x-webhook-signature =
 *    HMAC-SHA256 (hex) of the raw body with the webhook's secret; x-webhook-delivery-id is unique per delivery.
 *
 * NOT in the documented API (so not implemented — each throws or returns a clear failure):
 *  - Saving a card through the API. Documented only in the Morning UI: client record → "add credit card" → email
 *    request to the client, or manual entry. createSetupSession therefore throws.
 *  - Card refunds. Refunds are done in the Morning UI; the credit invoice it issues arrives by webhook.
 *  - An idempotency key. Duplicate protection is LINKUP's: one charge per payment request, and a later attempt first
 *    searches Morning for a document carrying the request's reference (findCharge).
 */
type Env = { keyId?: string; secret?: string; apiBase: string; idpBase?: string; webhookSecret?: string; lang: "he" | "en" };
type Fetch = typeof fetch;

export const MORNING_PROD = { api: "https://api.greeninvoice.co.il/api/v1", idp: "https://api.morning.co" };
export const MORNING_SANDBOX_API = "https://sandbox.d.greeninvoice.co.il/api/v1";

export function morningEnv(e: Record<string, string | undefined> = process.env): Env {
  const sandbox = e.MORNING_ENV !== "production";
  return {
    keyId: e.MORNING_API_KEY_ID, secret: e.MORNING_API_KEY_SECRET, webhookSecret: e.MORNING_WEBHOOK_SECRET, lang: "he",
    apiBase: sandbox ? MORNING_SANDBOX_API : MORNING_PROD.api,
    // The sandbox token host is not stated in the reference → must be set explicitly from Morning's sandbox docs/support.
    idpBase: sandbox ? e.MORNING_SANDBOX_IDP_URL : MORNING_PROD.idp,
  };
}

/** Reference placed in the document description so a lost charge can be found again (one charge per request). */
export const chargeRef = (invoiceId: string) => `LINKUP-${invoiceId}`;
const major = (minor: number) => Math.round(minor) / 100;

export function morningClient(env: Env, f: Fetch = fetch) {
  let token: { value: string; until: number } | null = null;
  const auth = async () => {
    if (!env.keyId || !env.secret || !env.idpBase) throw new Error("morning_not_connected: missing credentials");
    if (token && token.until > Date.now() + 60_000) return token.value;
    const r = await f(`${env.idpBase}/idp/v1/oauth/token`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", client_id: env.keyId, client_secret: env.secret }) });
    const j = (await r.json().catch(() => ({}))) as { accessToken?: string };
    if (!r.ok || !j.accessToken) throw new Error(`morning_auth_failed: ${r.status}`);
    token = { value: j.accessToken, until: Date.now() + 55 * 60_000 };   // documented validity: 1 hour
    return token.value;
  };
  const call = async <T>(path: string, body: unknown): Promise<{ status: number; json: T }> => {
    const r = await f(`${env.apiBase}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await auth()}` },
      body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as T };
  };
  return { call, auth };
}

export function morningPayments(env: Env = morningEnv(), f: Fetch = fetch): PaymentProvider {
  const api = morningClient(env, f);
  const toDoc = (d: { id: string; number: number | string; url?: { origin?: string } }, feeMinor: number, vatMinor: number): IssuedDocument => ({
    docType: "tax_invoice_receipt", number: String(d.number), issuedOn: new Date().toISOString().slice(0, 10),
    amountMinor: feeMinor, vatMinor, providerDocId: d.id, url: d.url?.origin });
  return {
    name: "morning",
    async createSetupSession() {
      throw new Error("morning_card_saving_not_in_api: cards are saved from the Morning client record (email request to the store)");
    },
    async charge(req): Promise<ChargeResult> {
      if (!req.invoice) return { ok: false, code: "invoice_missing", message: "Payment request details are required" };
      const { feeMinor, vatMinor, offsetMinor } = req.invoice;
      // The automatic document is for the charged amount only. With an offset, the fee + VAT must be documented in
      // full and the offset separately (accounting rule) → not charged here until that flow is verified with Morning.
      if (offsetMinor > 0) return { ok: false, code: "offset_needs_separate_documents", message: "Offset requests are collected manually" };
      if (feeMinor + vatMinor !== req.amountMinor) return { ok: false, code: "amount_mismatch", message: "Charge amount differs from fee + VAT" };
      if (req.currency !== "ILS") return { ok: false, code: "currency_not_supported", message: "Morning clearing is in ILS only" };
      const r = await api.call<{ id?: string; number?: number; url?: { origin?: string }; vatRate?: number; transactionId?: string;
        errorCode?: number; errorMessage?: string }>(`/payments/tokens/${encodeURIComponent(req.tokenRef)}/charge`, {
        type: 320, amount: major(req.amountMinor), currency: "ILS", lang: env.lang,
        vatType: vatMinor === 0 ? 1 : 0,                       // 1 = exempt (verified zero-rate store); 0 = by business type
        description: chargeRef(req.invoiceId),
        income: [{ description: "עמלת שירות LINKUP", quantity: 1, price: major(feeMinor), currency: "ILS", vatType: vatMinor === 0 ? 2 : 0 }],
        remarks: `LINKUP payment request ${req.invoiceId}`,
      });
      // 5xx or an unreadable answer: Morning may have charged → unknown, never a decline.
      if (r.status >= 500 || (r.status < 300 && !r.json.id)) {
        return { ok: false, code: `morning_${r.status}`, message: "no definite answer from Morning", unknown: true };
      }
      if (r.status >= 300) {
        return { ok: false, code: `morning_${r.json.errorCode ?? r.status}`, message: String(r.json.errorMessage ?? "charge failed").slice(0, 200) };
      }
      // The document must carry the VAT LINKUP calculated. On a different rate the money is still charged (paid), but the
      // document is not recorded automatically → it appears in the exceptions queue as "tax document missing".
      if (typeof r.json.vatRate === "number") {
        const rate = r.json.vatRate > 1 ? r.json.vatRate / 100 : r.json.vatRate;   // documented as a fraction (0–1)
        if (Math.abs(Math.round(feeMinor * rate) - vatMinor) > 1) return { ok: true, providerRef: String(r.json.transactionId ?? r.json.id) };
      }
      return { ok: true, providerRef: String(r.json.transactionId ?? r.json.id), document: toDoc(r.json as { id: string; number: number }, feeMinor, vatMinor) };
    },
    async findCharge(invoiceId) {
      const ref = chargeRef(invoiceId);
      const r = await api.call<{ items?: { id: string; number: string; description?: string; amount?: number; vat?: number; url?: { origin?: string } }[] }>(
        "/documents/search", { type: [320], description: ref, pageSize: 10 });
      const d = (r.json.items ?? []).find((x) => x.description === ref);
      return d ? { providerRef: d.id, document: { docType: "tax_invoice_receipt", number: String(d.number), issuedOn: new Date().toISOString().slice(0, 10),
        amountMinor: Math.round(((d.amount ?? 0) - (d.vat ?? 0)) * 100), vatMinor: Math.round((d.vat ?? 0) * 100), providerDocId: d.id, url: d.url?.origin } } : null;
    },
    async refund() {
      return { ok: false, message: "morning_refund_manual: card refunds are not in Morning's documented API; refund in Morning, its credit invoice arrives by webhook" };
    },
    async parseWebhook(headers, rawBody) {
      if (!env.webhookSecret) return null;                     // never accept unsigned deliveries
      const sig = headers.get("x-webhook-signature") ?? "";
      const expected = createHmac("sha256", env.webhookSecret).update(rawBody, "utf8").digest("hex");
      if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
      const id = headers.get("x-webhook-delivery-id");
      const topic = headers.get("x-webhook-topic");
      if (!id || !topic) return null;
      const payload = JSON.parse(rawBody) as Record<string, any>;
      // A tax invoice-receipt carrying a LINKUP request reference = that request's charge went through.
      const ref = typeof payload.description === "string" && payload.description.startsWith("LINKUP-") ? payload.description.slice(7) : null;
      const apply = topic === "document/created" && Number(payload.type) === 320 && ref
        ? { invoiceId: ref, outcome: "succeeded" as const, providerRef: String(payload.transactions?.[0]?.id ?? payload.id ?? "") || null } : undefined;
      return { eventId: id, kind: topic, payload, apply };
    },
  };
}

/** With Morning the tax invoice-receipt comes back from the charge itself; credit invoices come from refunds done in
 *  Morning (by webhook). Issuing documents separately here would risk a second document for the same payment. */
export function morningDocuments(): DocumentProvider {
  return {
    name: "morning",
    async issueInvoiceReceipt() { throw new Error("morning_document_comes_with_charge"); },
    async issueCreditNote() { throw new Error("morning_credit_invoice_comes_from_refund_in_morning"); },
  };
}
