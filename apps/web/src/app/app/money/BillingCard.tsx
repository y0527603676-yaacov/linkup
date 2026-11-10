import Link from "next/link";
import { money, shortDate } from "@/lib/format";
import type { Dict } from "@/i18n/he";
import { removePaymentMethod } from "../actions";

type Billing = { provider: string; auto_enabled: boolean; payment_terms_days: number;
  method: { brand: string | null; last4: string | null; exp_month: number | null; exp_year: number | null; charge_timing: string; charge_days: number | null; authorized_at: string } | null };

/** The store's one-time payment method for the LINKUP fee and the charge timing it chose. */
export function BillingCard({ t, locale, orgId, billing }: { t: Dict; locale: "he" | "en"; orgId: string; billing: Billing }) {
  const b = t.billing;
  const sim = process.env.BILLING_SIMULATION === "true" && billing.provider === "simulated";
  const canSetup = sim;   // the real provider's hosted page is connected only after approval
  const mt = billing.method;
  return (
    <section className="section">
      <div className="section-head"><h2>{b.title}</h2></div>
      <div className="card card-flat stack small">
        {!billing.auto_enabled && <p className="muted" style={{ margin: 0 }}>{b.off}</p>}
        {mt ? (
          <>
            <b>{b.card(mt.brand ?? "", mt.last4 ?? "", mt.exp_month ?? 0, mt.exp_year ?? 0)}</b>
            <span>{b.timing}: {mt.charge_timing === "on_due_date" ? b.timingDue : b.timingDays(mt.charge_days ?? 0)} · {shortDate(mt.authorized_at, locale)}</span>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              {canSetup && <Link className="btn btn-ghost btn-sm" href={`/app/billing/simulated-checkout?org=${orgId}`}>{b.replace}</Link>}
              <form action={removePaymentMethod}><input type="hidden" name="org" value={orgId} /><button className="btn btn-ghost btn-sm">{b.remove}</button></form>
            </div>
          </>
        ) : canSetup ? (
          <>
            <span>{b.none}</span>
            <Link className="btn btn-primary btn-sm" href={`/app/billing/simulated-checkout?org=${orgId}`} style={{ alignSelf: "flex-start" }}>{b.setup}</Link>
          </>
        ) : <span>{b.soon}</span>}
      </div>
    </section>
  );
}
