import { redirect } from "next/navigation";
import { AppShell, PageHead } from "@/components/AppShell";
import { loadApp } from "@/lib/orgs";
import { saveSimulatedMethod } from "../../actions";

/** Development stand-in for the provider's hosted card page. Never available unless BILLING_SIMULATION=true. */
export default async function SimulatedCheckout({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp, "store");
  const { org, status, t } = ctx;
  if (process.env.BILLING_SIMULATION !== "true" || !status.is_admin) redirect(`/app/money?org=${org.id}`);
  const b = t.billing;
  return (
    <AppShell ctx={ctx} active="money" path="/app/money">
      <div className="narrow">
        <PageHead title={b.simTitle} lead={b.simLead} />
        <form action={saveSimulatedMethod} className="card stack">
          <input type="hidden" name="org" value={org.id} />
          {(["ok", "flaky", "decline"] as const).map((c, i) => (
            <label key={c} className="row" style={{ gap: 8 }}><input type="radio" name="card" value={c} defaultChecked={i === 0} style={{ width: "auto" }} />
              {c === "ok" ? b.simOk : c === "flaky" ? b.simFlaky : b.simDecline}</label>))}
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>{b.timing}</legend>
            <label className="row" style={{ gap: 8 }}><input type="radio" name="timing" value="days_after_delivery" defaultChecked style={{ width: "auto" }} />
              <input name="days" type="number" min={0} max={14} defaultValue={0} style={{ width: 70 }} dir="ltr" /> {b.timingDays(1).replace("1 ", "")}</label>
            <label className="row" style={{ gap: 8 }}><input type="radio" name="timing" value="on_due_date" style={{ width: "auto" }} />{b.timingDue}</label>
          </fieldset>
          <label className="row small" style={{ alignItems: "flex-start", gap: 8 }}><input type="checkbox" name="agree" value="1" required style={{ width: "auto", marginTop: 3 }} /><span>{b.authorize}</span></label>
          <button className="btn btn-primary">{b.simSave}</button>
        </form>
      </div>
    </AppShell>
  );
}
