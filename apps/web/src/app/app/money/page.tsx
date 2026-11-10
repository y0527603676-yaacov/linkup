import { AppShell, PageHead, Alert } from "@/components/AppShell";
import { loadApp } from "@/lib/orgs";
import { errorText, money, shortDate } from "@/lib/format";
import { recordPayout, respondPayout, respondFee } from "../actions";

type Bal = { other_org_id: string; other_name: string; currency: string; pending_minor: number | null; approved_unpaid_minor: number; paid_minor: number; due_at: string | null; overdue: boolean };
type Term = { id: string; kind: string; fee_bps: number; effective_from: string | null; effective_until: string | null; status: string };
const pct = (bps: number) => `${(bps / 100).toLocaleString("en", { maximumFractionDigits: 2 })}%`;

export default async function Money({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp);
  const { sb, org, status, t, locale } = ctx;
  const m = t.money;
  const isStore = org.type === "store";
  const [{ data: bal }, { data: payouts }, { data: invoices }, { data: fee }] = await Promise.all([
    sb.rpc("payout_balances", { p_org: org.id }),
    sb.from("creator_payouts").select("id, store_org_id, creator_org_id, amount_minor, currency, method, reference, paid_at, creator_status")
      .eq(isStore ? "store_org_id" : "creator_org_id", org.id).order("paid_at", { ascending: false }).limit(30),
    isStore && status.is_admin ? sb.from("invoices").select("*").eq("store_org_id", org.id).neq("status", "void").order("period_start", { ascending: false }).limit(24) : Promise.resolve({ data: [] as any[] }),
    isStore && status.is_admin ? sb.rpc("store_fee_terms", { p_store: org.id }) : Promise.resolve({ data: null }),
  ]);
  const terms = ((fee as any)?.terms ?? []) as Term[];
  const now = Date.now();
  const d = (x: string | null) => (x ? shortDate(x, locale) : "");
  const balances = (bal ?? []) as Bal[];
  const names = Object.fromEntries(balances.map((b) => [b.other_org_id, b.other_name]));
  const methods = Object.entries(m.methods);
  return (
    <AppShell ctx={ctx} active="money" path="/app/money">
      <PageHead title={m.title} lead={isStore ? m.storeLead : m.creatorLead} />
      <Alert text={errorText(sp.error, t)} />
      {sp.ok && <Alert kind="ok" text={t.common.saved} />}

      {isStore && status.is_admin && fee && (
        <section className="section">
          <div className="section-head"><h2>{m.feeTitle}</h2></div>
          <div className="card card-flat stack">
            {(fee as any).current_bps != null && <div className="row between"><b>{m.feeNow(pct((fee as any).current_bps))}</b></div>}
            {terms.filter((x) => x.status === "active").map((x) => (
              <div key={x.id} className={`row between small ${x.effective_from && new Date(x.effective_from).getTime() > now ? "" : "muted"}`}>
                <span>{m.feeKinds[x.kind] ?? x.kind}: {m.feeNow(pct(x.fee_bps))}</span>
                <span>{[x.effective_from && new Date(x.effective_from).getTime() > now ? m.feeFrom(d(x.effective_from)) : "", x.effective_until ? m.feeUntil(d(x.effective_until)) : ""].filter(Boolean).join(" · ")}</span>
              </div>
            ))}
            {terms.filter((x) => x.status === "proposed").map((x) => (
              <form key={x.id} action={respondFee} className="card card-flat stack" style={{ borderColor: "var(--warn, #c77700)" }}>
                <input type="hidden" name="org" value={org.id} /><input type="hidden" name="term" value={x.id} />
                <span>{m.feeProposed(pct(x.fee_bps), d(x.effective_from))}</span>
                <span className="small muted">{m.feeDeclinedNote}</span>
                <div className="row"><button className="btn btn-primary btn-sm" name="accept" value="1">{m.feeAccept}</button>
                  <button className="btn btn-ghost btn-sm" name="accept" value="0">{m.feeDecline}</button></div>
              </form>
            ))}
          </div>
        </section>
      )}

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
                {b.due_at && (
                  <div className="row small" style={{ marginTop: 6 }}>
                    <span className="muted">{m.payCreatorBy(shortDate(b.due_at, locale))}</span>
                    {b.overdue && <span className="badge badge-warn">{m.overdue}</span>}
                  </div>
                )}
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
        <p className="small muted">{m.creatorTaxNote}</p>
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
            <div className="stack">
              {(invoices ?? []).map((i: any) => (
                <div className="card card-flat" key={i.id}>
                  <div className="row between"><b>{m.invoice} #{i.number} · {new Date(i.period_start).toLocaleDateString(locale === "he" ? "he-IL" : "en-IL", { month: "long", year: "numeric" })}</b>
                    <span className="row">
                      {i.status === "issued" && i.due_at && new Date(i.due_at).getTime() < now && <span className="badge badge-warn">{m.overdue}</span>}
                      <span className={`badge ${i.status === "paid" ? "badge-money" : "badge-warn"}`}>{m.status[i.status]}</span></span></div>
                  <table className="t small" style={{ marginTop: 8 }}><tbody>
                    <tr><td>{m.fees}</td><td className="ltr">{money(i.fees_minor, i.currency, locale)}</td></tr>
                    <tr><td>{m.vat(pct(Number(i.vat_bps)))}</td><td className="ltr">{money(i.vat_minor, i.currency, locale)}</td></tr>
                    {Number(i.credit_minor) > 0 && <>
                      <tr><td>{m.rewardOffset}</td><td className="ltr">−{money(i.reward_offset_minor ?? i.credit_minor, i.currency, locale)}</td></tr>
                      {Number(i.reward_vat_minor) > 0 && <tr><td>{m.rewardVat(pct(Number(i.reward_vat_bps)))}</td><td className="ltr">−{money(i.reward_vat_minor, i.currency, locale)}</td></tr>}
                    </>}
                    <tr><td><b>{m.total}</b></td><td className="ltr"><b>{money(i.total_minor, i.currency, locale)}</b></td></tr>
                  </tbody></table>
                  {i.status === "issued" && <p className="small muted" style={{ marginTop: 6 }}>{i.due_at ? m.dueBy(shortDate(i.due_at, locale)) : m.awaitingDelivery}</p>}
                  {Number(i.credit_minor) > 0 && <p className="small muted">{m.offsetDocNote}</p>}
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
