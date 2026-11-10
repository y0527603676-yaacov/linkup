/**
 * Provider-neutral payment layer for collecting the LINKUP fee. Only this folder talks to providers;
 * the database holds the rules (what to charge, when, retries, what is paid). Card numbers never reach LINKUP.
 */
export type ChargeRequest = { chargeId: string; invoiceId: string; amountMinor: number; currency: string; tokenRef: string; idempotencyKey: string };
export type ChargeResult = { ok: true; providerRef: string } | { ok: false; providerRef?: string; code: string; message: string };
export type RefundRequest = { refundId: string; providerRef: string; amountMinor: number; currency: string };
export type RefundResult = { ok: true; providerRef: string } | { ok: false; message: string };

/** Collects money: a hosted page that saves a card (token), charges against the token, refunds. */
export interface PaymentProvider {
  readonly name: "simulated" | "morning";
  /** URL of the provider's hosted page where the store saves a card; it returns to `returnUrl` with a token. */
  createSetupSession(input: { storeOrgId: string; returnUrl: string }): Promise<{ url: string }>;
  charge(req: ChargeRequest): Promise<ChargeResult>;
  refund(req: RefundRequest): Promise<RefundResult>;
  /** Verifies a webhook's signature and normalises it. Returns null when the signature is not valid. */
  parseWebhook(headers: Headers, rawBody: string): Promise<{ eventId: string; kind: string; payload: Record<string, unknown> } | null>;
}

export type IssuedDocument = { docType: "tax_invoice_receipt" | "credit_note"; number: string; issuedOn: string; amountMinor: number; vatMinor: number };

/** Issues the official tax documents (tax invoice-receipt on payment, credit note on refund) with allocation numbers. */
export interface DocumentProvider {
  readonly name: "simulated" | "morning";
  issueInvoiceReceipt(input: { invoiceId: string; storeOrgId: string; feeMinor: number; vatMinor: number; totalMinor: number;
    offsetMinor: number; currency: string; paymentRef: string }): Promise<IssuedDocument>;
  issueCreditNote(input: { invoiceId: string; storeOrgId: string; amountMinor: number; currency: string; reason: string }): Promise<IssuedDocument>;
}

/** The runner reaches the database only through these named RPCs (service role). */
export type Rpc = <T = unknown>(fn: string, args?: Record<string, unknown>) => Promise<T>;
