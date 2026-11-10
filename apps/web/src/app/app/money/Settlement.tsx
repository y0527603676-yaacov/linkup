import Link from "next/link";
import { ChoiceButton } from "@/components/ChoiceButton";
import { money, shortDate } from "@/lib/format";
import type { Dict } from "@/i18n/he";
import { respondPayout, answerDispute, withdrawPayout, savePayoutDetails } from "../actions";

export type PairBal = { other_org_id: string; other_name: string; currency: string; sales: number; pending_minor: number; approved_minor: number;
  outstanding_minor: number; balance_minor: number; reported_minor: number; confirmed_minor: number; due_at: string | null; overdue: boolean; due_soon: boolean;
  awaiting_confirmation: number; vat_basis: string; vat_reason: string; vat_bps: number | null; outstanding_vat_minor: number | null;
  outstanding_gross_minor: number | null; reported_vat_minor: number; withheld_minor: number; transferred_minor: number };
export type Payout = { id: string; store_org_id: string; creator_org_id: string; amount_minor: number; vat_minor: number; withholding_minor: number; net_minor: number; currency: string; method: string;
  reference: string | null; paid_on: string | null; paid_at: string; creator_status: string; withdrawn_at: string | null; dispute_reason: string | null;
  store_response: string | null; withdraw_note: string | null };

/** Store ↔ creator settlement: the same numbers on both sides; LINKUP never holds or moves this money. */
export function Settlement({ t, locale, orgId, isStore, isAdmin, balances, payouts, details }: {
  t: Dict; locale: "he" | "en"; orgId: string; isStore: boolean; isAdmin: boolean; balances: PairBal[]; payouts: Payout[]; details: any;
}) {
  const p = t.pay;
  const m = (v: number | string, cur = "ILS") => money(Number(v), cur, locale);
  const names = Object.fromEntries(balances.map((b) => [b.other_org_id, b.other_name]));
  const tot = balances.reduce((a, b) => ({ out: a.out + Number(b.outstanding_minor), pend: a.pend + Number(b.pending_minor),
    conf: a.conf + Number(b.confirmed_minor), sales: a.sales + Number(b.sales) }), { out: 0, pend: 0, conf: 0, sales: 0 });
  const status = (x: Payout) => (x.withdrawn_at ? "withdrawn" : x.creator_status);
  return (
    <>
      {isAdmin && (
        <section className="stats">
          <div className="stat"><span>{p.sales}</span><b>{tot.sales}</b></div>
          <div className="stat"><span>{p.pending}</span><b>{m(tot.pend)}</b></div>
          <div className="stat stat-money"><span>{p.outstanding}</span><b>{m(tot.out)}</b></div>
          <div className="stat"><span>{p.confirmed}</span><b>{m(tot.conf)}</b></div>
        </section>
      )}

      <section className="section">
        <div className="section-head"><h2>{isStore ? t.money.toPartners : t.money.byStore}</h2></div>
        {balances.length === 0 ? <p className="empty">{t.money.nothing}</p> : (
          <div className="stack">
            {balances.map((b) => (
              <div className="card card-flat" key={b.other_org_id + b.currency}>
                <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
                  <b>{b.other_name}</b>
                  <span className="row small" style={{ flexWrap: "wrap" }}>
                    {b.overdue && <span className="badge badge-warn">{p.overdue}</span>}
                    {!b.overdue && b.due_soon && <span className="badge badge-warn">{p.dueSoon}</span>}
                    {Number(b.outstanding_minor) > 0 && <span className="badge badge-money">{p.outstanding}: {m(b.outstanding_minor, b.currency)}</span>}
                  </span>
                </div>
                <div className="small muted" style={{ marginTop: 6 }}>
                  {p.sales}: {b.sales} · {p.pending}: {m(b.pending_minor, b.currency)} · {p.approved}: {m(b.approved_minor, b.currency)} · {p.reported}: {m(b.reported_minor, b.currency)} · {p.confirmed}: {m(b.confirmed_minor, b.currency)}
                </div>
                {Number(b.outstanding_minor) > 0 && <TaxBreakdown t={t} b={b} m={m} />}
                {Number(b.reported_minor) > 0 && <div className="small muted" style={{ marginTop: 4 }}>{p.tx.transferredLine(m(b.reported_minor, b.currency), m(b.reported_vat_minor, b.currency), m(b.withheld_minor, b.currency), m(b.transferred_minor, b.currency))}</div>}
                {b.due_at && Number(b.outstanding_minor) > 0 && <div className="small" style={{ marginTop: 4 }}>{p.dueBy(shortDate(b.due_at, locale))}</div>}
                {Number(b.balance_minor) < 0 && <div className="small muted">{p.credit}: {m(-Number(b.balance_minor), b.currency)}</div>}
                {isAdmin && (
                  <div className="row" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
                    {isStore && Number(b.outstanding_minor) > 0 && <Link className="btn btn-primary btn-sm" href={`/app/money/pay?org=${orgId}&creator=${b.other_org_id}`}>{p.payBtn}</Link>}
                    <Link className="btn btn-ghost btn-sm" href={`/app/money/statement?org=${orgId}&with=${b.other_org_id}`}>{p.statement}</Link>
                    {!isStore && Number(b.outstanding_minor) > 0 && <Link className="btn btn-ghost btn-sm" href={`/app/money/statement?org=${orgId}&with=${b.other_org_id}&kind=request`}>{p.request}</Link>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="small muted" style={{ marginTop: 8 }}>{t.lc.pending}</p>
        <p className="small muted">{t.lc.tax}</p>
      </section>

      {payouts.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>{p.payments}</h2></div>
          <div className="stack">
            {payouts.map((x) => (
              <div className="card card-flat small" key={x.id}>
                <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
                  <b>{names[isStore ? x.creator_org_id : x.store_org_id] ?? "—"} · {p.tx.paymentLine(m(x.amount_minor, x.currency), m(x.vat_minor, x.currency), m(x.withholding_minor ?? 0, x.currency), m(x.net_minor ?? x.amount_minor, x.currency))}</b>
                  <span className={`badge ${status(x) === "confirmed" ? "badge-money" : status(x) === "awaiting" ? "" : "badge-warn"}`}>{p.statuses[status(x)]}</span>
                </div>
                <div className="muted">{shortDate(x.paid_on ?? x.paid_at, locale)} · {t.money.methods[x.method] ?? x.method}{x.reference ? ` · ${x.reference}` : ""}</div>
                {x.dispute_reason && <div>{p.reason} {x.dispute_reason}</div>}
                {x.store_response && <div>{p.answer}: {x.store_response}</div>}
                {x.withdraw_note && <div className="muted">{x.withdraw_note}</div>}
                {isAdmin && !isStore && !x.withdrawn_at && x.creator_status !== "confirmed" && (
                  <form action={respondPayout} className="stack" style={{ marginTop: 8 }}>
                    <input type="hidden" name="org" value={orgId} /><input type="hidden" name="id" value={x.id} />
                    <span>{t.lc.reported}</span>
                    {x.creator_status === "awaiting" && <input name="reason" placeholder={p.reason} maxLength={1000} />}
                    <div className="row" style={{ gap: 8 }}>
                      <ChoiceButton className="btn btn-primary btn-sm" name="confirm" value="1">{t.lc.received}</ChoiceButton>
                      {x.creator_status === "awaiting" && <ChoiceButton className="btn btn-ghost btn-sm" name="confirm" value="0">{t.lc.notReceived}</ChoiceButton>}
                    </div>
                  </form>
                )}
                {isAdmin && isStore && !x.withdrawn_at && x.creator_status === "disputed" && (
                  <form action={answerDispute} className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
                    <input type="hidden" name="org" value={orgId} /><input type="hidden" name="id" value={x.id} />
                    <input name="response" required placeholder={p.answer} style={{ flex: 1, minWidth: 160 }} /><button className="btn btn-ghost btn-sm">{p.answerBtn}</button>
                  </form>
                )}
                {isAdmin && isStore && !x.withdrawn_at && x.creator_status !== "confirmed" && (
                  <details style={{ marginTop: 6 }}><summary>{p.withdraw}</summary>
                    <form action={withdrawPayout} className="row" style={{ marginTop: 6, flexWrap: "wrap" }}>
                      <input type="hidden" name="org" value={orgId} /><input type="hidden" name="id" value={x.id} />
                      <input name="note" required placeholder={p.withdrawNote} style={{ flex: 1, minWidth: 160 }} /><button className="btn btn-danger btn-sm">{p.withdraw}</button>
                    </form></details>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {!isStore && isAdmin && (
        <section className="section">
          <div className="section-head"><h2>{p.myDetails}</h2></div>
          <form action={savePayoutDetails} className="card stack">
            <input type="hidden" name="org" value={orgId} />
            <p className="small muted" style={{ margin: 0 }}>{p.myDetailsLead}</p>
            <label className="field"><span>{t.money.method}</span>
              <select name="method" defaultValue={details?.method ?? "bank_transfer"}>{Object.entries(p.methods).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="field"><span>{p.holder}</span><input name="holder" maxLength={120} defaultValue={details?.holder_name ?? ""} /></label>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <label className="field" style={{ flex: 1, minWidth: 80 }}><span>{p.bank}</span><input name="bank" inputMode="numeric" dir="ltr" maxLength={3} defaultValue={details?.bank_code ?? ""} /></label>
              <label className="field" style={{ flex: 1, minWidth: 80 }}><span>{p.branch}</span><input name="branch" inputMode="numeric" dir="ltr" maxLength={4} defaultValue={details?.branch ?? ""} /></label>
              <label className="field" style={{ flex: 2, minWidth: 120 }}><span>{p.account}</span><input name="account" inputMode="numeric" dir="ltr" maxLength={13} defaultValue={details?.account_number ?? ""} /></label>
            </div>
            <label className="field"><span>{p.phone} (Bit / PayBox)</span><input name="phone" inputMode="tel" dir="ltr" defaultValue={details?.phone ?? ""} /></label>
            <label className="field"><span>{p.methods.payment_link}</span><input name="link" dir="ltr" inputMode="url" placeholder="https://" defaultValue={details?.payment_link ?? ""} /></label>
            <button className="btn btn-primary">{p.save}</button>
          </form>
        </section>
      )}
    </>
  );
}

/** Base commission (before VAT) · VAT only by a verified basis · withholding entered at payment · net to transfer. */
export function TaxBreakdown({ t, b, m }: { t: Dict; b: PairBal; m: (v: number | string, cur?: string) => string }) {
  const x = t.pay.tx;
  const known = b.vat_bps !== null && b.vat_bps !== undefined;
  const row = (label: string, value: string) => (
    <div className="row between" style={{ gap: 12 }}><span>{label}</span><b className="ltr" style={{ whiteSpace: "nowrap" }}>{value}</b></div>);
  return (
    <div className="small stack" style={{ marginTop: 6, gap: 4 }}>
      {row(x.base, m(b.outstanding_minor, b.currency))}
      {row(`${x.vat}${known ? ` (${(Number(b.vat_bps) / 100).toFixed(0)}%)` : ""}`, known ? m(b.outstanding_vat_minor ?? 0, b.currency) : x.undetermined)}
      {row(x.net, known ? m(b.outstanding_gross_minor ?? 0, b.currency) : x.undetermined)}
      <span className="muted">{x.withholding}: {x.withholdingAtPay}</span>
      {!known && <span className="muted">{x.reasons[b.vat_reason] ?? x.reasons.classification_unverified}</span>}
    </div>
  );
}
