import { redirect } from "next/navigation";
import { AppShell, PageHead, Alert } from "@/components/AppShell";
import { CopyButton } from "@/components/CopyButton";
import { loadApp } from "@/lib/orgs";
import { errorText, money, shortDate } from "@/lib/format";
import { reportPayment } from "../../actions";
import { TaxBreakdown } from "../Settlement";

/** "Pay the creator": what is due, how to pay (copy details / open her payment link), then report the payment.
 *  Nothing here moves money; copying details or opening a link is never recorded as a payment. */
export default async function Pay({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp, "store");
  const { sb, org, status, t, locale } = ctx;
  if (!status.is_admin || !sp.creator) redirect(`/app/money?org=${org.id}`);
  const p = t.pay;
  const { data: bals } = await sb.rpc("payout_balances", { p_org: org.id });
  const b = ((bals ?? []) as any[]).find((x) => x.other_org_id === sp.creator);
  if (!b || Number(b.outstanding_minor) <= 0) redirect(`/app/money?org=${org.id}&error=nothing_to_pay`);
  const { data: det } = await sb.rpc("payee_details", { p_store: org.id, p_creator: sp.creator });
  const d = det as any;
  const amount = (Number(b.outstanding_minor) / 100).toFixed(2);
  const known = b.vat_bps !== null && b.vat_bps !== undefined;
  const toCopy = known ? Number(b.outstanding_gross_minor) : Number(b.outstanding_minor);
  const key = crypto.randomUUID();
  const row = (label: string, value: string | null | undefined) => value ? (
    <div className="row between" style={{ gap: 8 }}><span className="muted">{label}</span><span className="row" style={{ gap: 8 }}><b className="ltr">{value}</b><CopyButton text={value} label={p.copy} /></span></div>
  ) : null;
  return (
    <AppShell ctx={ctx} active="money" path="/app/money">
      <div className="narrow">
        <PageHead title={`${p.title}: ${b.other_name}`} />
        <Alert text={errorText(sp.error, t)} />
        <div className="card stack">
          <div className="row between"><span>{known ? p.tx.netBeforeWithholding : p.tx.base}</span><span className="row" style={{ gap: 8 }}><b className="amount">{money(toCopy, b.currency, locale)}</b><CopyButton text={(toCopy / 100).toFixed(2)} label={p.copy} /></span></div>
          <TaxBreakdown t={t} b={b} m={(v, cur = "ILS") => money(Number(v), cur, locale)} />
          {b.due_at && <div className="row small" style={{ gap: 8 }}><span>{p.dueBy(shortDate(b.due_at, locale))}</span>{b.overdue && <span className="badge badge-warn">{p.overdue}</span>}</div>}
        </div>
        <section className="section">
          <div className="section-head"><h2>{p.howTo}</h2></div>
          {!d ? <p className="alert alert-warn">{p.noDetails}</p> : (
            <div className="card stack">
              <b>{p.methods[d.method] ?? d.method}</b>
              {row(p.holder, d.holder_name)}{row(p.bank, d.bank_code)}{row(p.branch, d.branch)}{row(p.account, d.account_number)}{row(p.phone, d.phone)}
              {d.payment_link && <a className="btn btn-ghost btn-sm" href={d.payment_link} target="_blank" rel="noopener noreferrer" style={{ alignSelf: "flex-start" }}>{p.link}</a>}
              <p className="small alert alert-warn" style={{ margin: 0 }}>{p.notPaidWarning}</p>
            </div>
          )}
        </section>
        <section className="section">
          <div className="section-head"><h2>{p.reportTitle}</h2></div>
          <form action={reportPayment} className="card stack">
            <input type="hidden" name="org" value={org.id} /><input type="hidden" name="creator" value={sp.creator} /><input type="hidden" name="key" value={key} />
            <label className="field"><span>{p.tx.amountField}</span><input name="amount" required inputMode="decimal" dir="ltr" defaultValue={amount} /></label>
            <p className="small muted" style={{ margin: 0 }}>{p.partialNote}</p>
            <p className="small" style={{ margin: 0 }}>{b.vat_bps === null || b.vat_bps === undefined ? p.tx.vatNotAdded : p.tx.vatAuto((Number(b.vat_bps) / 100).toFixed(0))}</p>
            <label className="field"><span>{p.tx.withholdingField}</span><input name="withholding" inputMode="decimal" dir="ltr" defaultValue="0" /></label>
            <label className="field"><span>{p.tx.withholdingRef}</span><input name="withholding_ref" maxLength={120} /></label>
            <p className="small muted" style={{ margin: 0 }}>{p.tx.withholdingNote}</p>
            <label className="field"><span>{t.money.method}</span>
              <select name="method" defaultValue={d?.method === "bit" || d?.method === "paybox" ? d.method : "bank_transfer"}>{Object.entries(t.money.methods).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="field"><span>{p.paidOn}</span><input type="date" name="paid_on" defaultValue={new Date().toISOString().slice(0, 10)} /></label>
            <label className="field"><span>{t.money.reference}</span><input name="reference" maxLength={120} /></label>
            <label className="field"><span>{p.proof}</span><input type="file" name="proof" accept="application/pdf,image/png,image/jpeg,image/webp" /></label>
            <button className="btn btn-primary">{p.report}</button>
          </form>
        </section>
      </div>
    </AppShell>
  );
}
