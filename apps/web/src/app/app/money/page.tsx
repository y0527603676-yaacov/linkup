import { AppShell, PageHead, Alert } from "@/components/AppShell";
import { loadApp } from "@/lib/orgs";
import { errorText, money, shortDate } from "@/lib/format";
import { recordPayout, respondPayout } from "../actions";

type Bal = { other_org_id: string; other_name: string; currency: string; pending_minor: number | null; approved_unpaid_minor: number; paid_minor: number };

export default async function Money({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp);
  const { sb, org, status, t, locale } = ctx;
  const m = t.money;
  const isStore = org.type === "store";
  const [{ data: bal }, { data: payouts }, { data: invoices }] = await Promise.all([
    sb.rpc("payout_balances", { p_org: org.id }),
    sb.from("creator_payouts").select("id, store_org_id, creator_org_id, amount_minor, currency, method, reference, paid_at, creator_status")
      .eq(isStore ? "store_org_id" : "creator_org_id", org.id).order("paid_at", { ascending: false }).limit(30),
    isStore && status.is_admin ? sb.from("invoices").select("*").eq("store_org_id", org.id).neq("status", "void").order("period_start", { ascending: false }).limit(24) : Promise.resolve({ data: [] as any[] }),
  ]);
  const balances = (bal ?? []) as Bal[];
  const names = Object.fromEntries(balances.map((b) => [b.other_org_id, b.other_name]));
  const methods = Object.entries(m.methods);
  return (
    <AppShell ctx={ctx} active="money" path="/app/money">
      <PageHead title={m.title} lead={isStore ? m.storeLead : m.creatorLead} />
      <Alert text={errorText(sp.error, t)} />
      {sp.ok && <Alert kind="ok" text={t.common.saved} />}

      <section className="section">
        <div className="section-head"><h2>{isStore ? m.toPartners : m.byStore}</h2></div>
        {balances.length === 0 ? <p className="empty">{m.nothing}</p> : (
          <div className="stack">
            {balances.map((b) => (
              <div className="card card-flat" key={b.other_org_id + b.currency}>
                <div className="row between"><b>{b.other_name}</b>
                  <span className="row small"><span className="muted">{m.pending}: {money(b.pending_minor ?? 0, b.currency, locale)}</span>
                    <span className="badge badge-money">{m.approvedUnpaid}: {money(b.approved_unpaid_minor, b.currency, locale)}</span>
                    <span className="muted">{m.paid}: {money(b.paid_minor, b.currency, locale)}</span></span></div>
                {isStore && status.is_admin && Number(b.approved_unpaid_minor) > 0 && (
                  <form action={recordPayout} className="row" style={{ marginTop: 12 }}>
                    <input type="hidden" name="org" value={org.id} /><input type="hidden" name="creator" value={b.other_org_id} /><input type="hidden" name="currency" value={b.currency} />
                    <select name="method" aria-label={m.method} style={{ width: "auto" }}>{methods.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                    <input name="reference" placeholder={m.reference} maxLength={120} style={{ flex: 1, minWidth: 120 }} />
                    <button className="btn btn-primary btn-sm">{m.markPaid} · {money(b.approved_unpaid_minor, b.currency, locale)}</button>
                  </form>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="small muted" style={{ marginTop: 8 }}>{m.approvedNote}</p>
      </section>

      {(payouts ?? []).length > 0 && (
        <section className="section">
          <div className="section-head"><h2>{m.payouts}</h2></div>
          <div className="list">
            {(payouts ?? []).map((p) => (
              <div className="item" key={p.id}>
                <div className="grow"><div className="title">{names[isStore ? p.creator_org_id : p.store_org_id] ?? "—"}</div>
                  <div className="meta">{shortDate(p.paid_at, locale)} · {m.methods[p.method]}{p.reference ? ` · ${p.reference}` : ""}</div></div>
                <span className="amount">{money(p.amount_minor, p.currency, locale)}</span>
                {p.creator_status === "awaiting" && !isStore && status.is_admin ? (
                  <form action={respondPayout} className="row"><input type="hidden" name="org" value={org.id} /><input type="hidden" name="id" value={p.id} />
                    <button className="btn btn-primary btn-sm" name="confirm" value="1">{m.confirm}</button>
                    <button className="btn btn-ghost btn-sm" name="confirm" value="0">{m.dispute}</button></form>
                ) : <span className={`badge ${p.creator_status === "confirmed" ? "badge-money" : p.creator_status === "disputed" ? "badge-warn" : ""}`}>
                    {p.creator_status === "confirmed" ? m.confirmed : p.creator_status === "disputed" ? m.disputed : m.awaiting}</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      {isStore && status.is_admin && (
        <section className="section">
          <div className="section-head"><h2>{m.invoices}</h2></div>
          {(invoices ?? []).length === 0 ? <p className="empty">{m.noInvoices}</p> : (
            <div className="list">
              {(invoices ?? []).map((i: any) => (
                <div className="item" key={i.id}>
                  <div className="grow"><div className="title">{m.invoice} #{i.number} · {new Date(i.period_start).toLocaleDateString(locale === "he" ? "he-IL" : "en-IL", { month: "long", year: "numeric" })}</div>
                    <div className="meta">{m.fees}: {money(i.fees_minor, i.currency, locale)}{Number(i.credit_minor) > 0 ? ` · ${m.credit}: −${money(i.credit_minor, i.currency, locale)}` : ""}</div></div>
                  <span className="amount">{money(i.total_minor, i.currency, locale)}</span>
                  <span className={`badge ${i.status === "paid" ? "badge-money" : "badge-warn"}`}>{m.status[i.status]}</span>
                </div>
              ))}
            </div>
          )}
          <p className="small muted" style={{ marginTop: 8 }}>{m.invoiceNote} {m.payHow}</p>
        </section>
      )}
    </AppShell>
  );
}
