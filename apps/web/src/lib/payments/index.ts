import { morningDocuments, morningPayments } from "./morning";
import { simulatedDocuments, simulatedPayments } from "./simulated";

export type { DocumentProvider, PaymentProvider } from "./types";
export { runBilling } from "./runner";

/** BILLING_PROVIDER=simulated (default, dev) | morning (only after it is connected and approved). */
export function billingProviders() {
  const name = process.env.BILLING_PROVIDER === "morning" ? "morning" : "simulated";
  return name === "morning"
    ? { name, pay: morningPayments(), docs: morningDocuments() }
    : { name, pay: simulatedPayments(), docs: simulatedDocuments() };
}
