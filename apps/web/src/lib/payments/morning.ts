import type { DocumentProvider, PaymentProvider } from "./types";

/**
 * Morning (Green Invoice) with its built-in clearing — the preferred provider (owner decision, 10.11.2026),
 * subject to verifying capabilities, terms and costs before any contract. NOT CONNECTED.
 *
 * Ready on LINKUP's side: the interfaces below, the runner, the database rules, the webhook route and the store
 * screens. To connect (after approval): a Morning account on a plan with API + Webhooks, API key id/secret in
 * server env (MORNING_API_KEY_ID / MORNING_API_KEY_SECRET), sandbox access, and Morning's API reference for:
 *   1. hosted payment form that saves a card (token)      → createSetupSession
 *   2. charge against a saved card                        → charge
 *   3. refund / credit                                    → refund + issueCreditNote
 *   4. tax invoice-receipt on payment (allocation number) → issueInvoiceReceipt
 *   5. webhook signature                                  → parseWebhook
 * Each method throws until it is implemented against the verified documentation, so nothing can charge by accident.
 */
const notConnected = (what: string) => {
  throw new Error(`morning_not_connected: ${what}`);
};

export function morningPayments(): PaymentProvider {
  return {
    name: "morning",
    createSetupSession: async () => notConnected("createSetupSession"),
    charge: async () => notConnected("charge"),
    refund: async () => notConnected("refund"),
    parseWebhook: async () => notConnected("parseWebhook"),
  };
}

export function morningDocuments(): DocumentProvider {
  return {
    name: "morning",
    issueInvoiceReceipt: async () => notConnected("issueInvoiceReceipt"),
    issueCreditNote: async () => notConnected("issueCreditNote"),
  };
}
