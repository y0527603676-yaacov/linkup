import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chargeRef, morningEnv, morningPayments, MORNING_SANDBOX_API } from "../src/lib/payments/morning";
import { runBilling } from "../src/lib/payments/runner";
import { simulatedDocuments } from "../src/lib/payments/simulated";

/** Morning adapter against a mocked HTTP layer shaped like Morning's documented API. No network, no money. */
type Call = { url: string; body: any; auth?: string };
const env = { keyId: "kid", secret: "sec", apiBase: MORNING_SANDBOX_API, idpBase: "https://idp.test", webhookSecret: "whsec", lang: "he" as const };
const mock = (routes: Record<string, (body: any) => { status?: number; json: any }>) => {
  const calls: Call[] = [];
  const f = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, auth: init.headers.authorization });
    const key = Object.keys(routes).find((k) => url.endsWith(k))!;
    const r = routes[key]!(body);
    return { ok: (r.status ?? 200) < 300, status: r.status ?? 200, json: async () => r.json } as Response;
  }) as typeof fetch;
  return { f, calls };
};
const token = { "/idp/v1/oauth/token": () => ({ json: { accessToken: "AT" } }) };
const req = (over: Record<string, unknown> = {}) => ({ chargeId: "ch1", invoiceId: "inv-1", amountMinor: 11_800, currency: "ILS", tokenRef: "tok-9",
  idempotencyKey: "ch1:1", invoice: { feeMinor: 10_000, vatMinor: 1_800, offsetMinor: 0 }, ...over });

describe("configuration", () => {
  it("defaults to the sandbox; production only when asked; sandbox token host must be set explicitly", () => {
    expect(morningEnv({}).apiBase).toBe("https://sandbox.d.greeninvoice.co.il/api/v1");
    expect(morningEnv({}).idpBase).toBeUndefined();
    expect(morningEnv({ MORNING_ENV: "production" })).toMatchObject({ apiBase: "https://api.greeninvoice.co.il/api/v1", idpBase: "https://api.morning.co" });
  });
  it("without credentials nothing is called", async () => {
    const m = mock(token);
    await expect(morningPayments({ ...env, keyId: undefined }, m.f).charge(req())).rejects.toThrow(/morning_not_connected/);
    expect(m.calls).toHaveLength(0);
  });
});

describe("charge a saved card", () => {
  it("OAuth token once, then one charge that returns the tax invoice-receipt", async () => {
    const m = mock({ ...token, "/payments/tokens/tok-9/charge": () => ({ json: { id: "doc-1", number: 50012, type: 320, vatRate: 0.18,
      transactionId: "tx-7", url: { origin: "https://doc" } } }) });
    const pay = morningPayments(env, m.f);
    const r = await pay.charge(req());
    expect(m.calls[0]!.body).toEqual({ grant_type: "client_credentials", client_id: "kid", client_secret: "sec" });
    expect(m.calls[1]!.auth).toBe("Bearer AT");
    expect(m.calls[1]!.body).toMatchObject({ type: 320, amount: 118, currency: "ILS", vatType: 0, description: chargeRef("inv-1"),
      income: [{ quantity: 1, price: 100, currency: "ILS", vatType: 0 }] });
    expect(r).toEqual({ ok: true, providerRef: "tx-7", document: expect.objectContaining({ docType: "tax_invoice_receipt", number: "50012",
      amountMinor: 10_000, vatMinor: 1_800, providerDocId: "doc-1" }) });
    await pay.charge(req());
    expect(m.calls.filter((c) => c.url.endsWith("/oauth/token"))).toHaveLength(1);   // token reused within its hour
  });
  it("refuses what the documented flow cannot document correctly", async () => {
    const m = mock(token);
    const pay = morningPayments(env, m.f);
    expect(await pay.charge(req({ invoice: { feeMinor: 10_000, vatMinor: 1_800, offsetMinor: 500 }, amountMinor: 11_300 })))
      .toMatchObject({ ok: false, code: "offset_needs_separate_documents" });
    expect(await pay.charge(req({ amountMinor: 9_000 }))).toMatchObject({ ok: false, code: "amount_mismatch" });
    expect(await pay.charge(req({ currency: "USD" }))).toMatchObject({ ok: false, code: "currency_not_supported" });
    expect(m.calls).toHaveLength(0);
  });
  it("a declined card is a failure with Morning's code", async () => {
    const m = mock({ ...token, "/charge": () => ({ status: 400, json: { errorCode: 2417, errorMessage: "declined" } }) });
    expect(await morningPayments(env, m.f).charge(req())).toMatchObject({ ok: false, code: "morning_2417" });
  });
  it("a 5xx or an unreadable answer is 'unknown', never a decline", async () => {
    const m5 = mock({ ...token, "/charge": () => ({ status: 502, json: {} }) });
    expect(await morningPayments(env, m5.f).charge(req())).toMatchObject({ ok: false, unknown: true });
    const m0 = mock({ ...token, "/charge": () => ({ status: 200, json: {} }) });
    expect(await morningPayments(env, m0.f).charge(req())).toMatchObject({ ok: false, unknown: true });
  });
  it("a different VAT rate: charged, but the document is not recorded automatically", async () => {
    const m = mock({ ...token, "/charge": () => ({ json: { id: "doc-2", number: 1, vatRate: 0.17, transactionId: "tx-8" } }) });
    expect(await morningPayments(env, m.f).charge(req())).toEqual({ ok: true, providerRef: "tx-8" });
  });
  it("card saving and refunds are not in the documented API", async () => {
    const pay = morningPayments(env, mock(token).f);
    await expect(pay.createSetupSession({ storeOrgId: "s", returnUrl: "/" })).rejects.toThrow(/card_saving_not_in_api/);
    expect(await pay.refund({ refundId: "r", providerRef: "x", amountMinor: 1, currency: "ILS" })).toMatchObject({ ok: false });
  });
});

describe("no double charge", () => {
  it("findCharge locates an earlier charge by the request reference", async () => {
    const m = mock({ ...token, "/documents/search": () => ({ json: { items: [
      { id: "other", number: "1", description: "LINKUP-inv-10", amount: 1, vat: 0 },
      { id: "doc-1", number: "50012", description: "LINKUP-inv-1", amount: 118, vat: 18 }] } }) });
    const found = await morningPayments(env, m.f).findCharge!("inv-1");
    expect(m.calls[1]!.body).toEqual({ type: [320], description: "LINKUP-inv-1", pageSize: 10 });
    expect(found).toMatchObject({ providerRef: "doc-1", document: { number: "50012", amountMinor: 10_000, vatMinor: 1_800 } });
  });

  it("runner: a retry after a lost response records the earlier charge instead of charging again", async () => {
    const m = mock({ ...token, "/documents/search": () => ({ json: { items: [{ id: "doc-1", number: "50012", description: "LINKUP-inv-1", amount: 118, vat: 18 }] } }),
      "/charge": () => { throw new Error("must not charge"); } });
    const calls: [string, any][] = [];
    const rpc = (async (fn: string, args?: any) => {
      calls.push([fn, args]);
      if (fn === "billing_schedule") return 0;
      if (fn === "billing_claim_due") return [{ charge_id: "ch1", invoice_id: "inv-1", store_org_id: "s", amount_minor: 11_800, currency: "ILS", attempt: 2,
        idempotency_key: "ch1:2", provider: "morning", token_ref: "tok-9" }];
      if (fn === "billing_complete_charge") return { result: "paid" };
      if (fn === "billing_invoice_summary") return { fees_minor: 10_000, vat_minor: 1_800, total_minor: 11_800, credit_minor: 0, currency: "ILS", store_org_id: "s" };
      if (fn === "billing_claim_refunds" || fn === "billing_unknown_open") return [];
      return 0;
    }) as any;
    const r = await runBilling(rpc, morningPayments(env, m.f), { ...simulatedDocuments(), name: "morning" });
    expect(r).toMatchObject({ charged: 1, documents: 1, errors: [] });   // attempt 2 found attempt 1 at Morning
    expect(calls.find(([f]) => f === "billing_complete_charge")![1]).toMatchObject({ p_success: true, p_provider_ref: "doc-1" });
    expect(calls.find(([f]) => f === "billing_record_document")![1]).toMatchObject({ p_number: "50012", p_amount_minor: 10_000, p_vat_minor: 1_800 });
    expect(m.calls.some((c) => c.url.endsWith("/charge"))).toBe(false);
  });
});

describe("webhooks", () => {
  const body = JSON.stringify({ id: "doc-1", type: 320, number: 50012 });
  const sign = (s: string) => createHmac("sha256", s).update(body).digest("hex");
  const h = (sig: string | null, extra: Record<string, string> = {}) =>
    new Headers({ ...(sig ? { "x-webhook-signature": sig } : {}), "x-webhook-delivery-id": "dl-1", "x-webhook-topic": "document/created", ...extra });
  it("accepts only a valid HMAC-SHA256 of the raw body", async () => {
    const pay = morningPayments(env, mock(token).f);
    expect(await pay.parseWebhook(h(sign("whsec")), body)).toMatchObject({ eventId: "dl-1", kind: "document/created", payload: { id: "doc-1", type: 320, number: 50012 } });
    expect(await pay.parseWebhook(h(sign("wrong")), body)).toBeNull();
    expect(await pay.parseWebhook(h(null), body)).toBeNull();
    expect(await pay.parseWebhook(h(sign("whsec")), body.replace("50012", "50013"))).toBeNull();
  });
  it("a LINKUP tax invoice-receipt is applied to its payment request", async () => {
    const b2 = JSON.stringify({ id: "doc-9", type: 320, description: "LINKUP-inv-1", transactions: [{ id: "tx-9" }] });
    const ev = await morningPayments(env, mock(token).f).parseWebhook(new Headers({ "x-webhook-signature": createHmac("sha256", "whsec").update(b2).digest("hex"),
      "x-webhook-delivery-id": "dl-9", "x-webhook-topic": "document/created" }), b2);
    expect(ev!.apply).toEqual({ invoiceId: "inv-1", outcome: "succeeded", providerRef: "tx-9" });
  });
  it("without a configured secret nothing is accepted", async () => {
    expect(await morningPayments({ ...env, webhookSecret: undefined }, mock(token).f).parseWebhook(h(sign("whsec")), body)).toBeNull();
  });
});
