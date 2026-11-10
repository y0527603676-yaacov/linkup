import Link from "next/link";
import { redirect } from "next/navigation";
import { loadApp } from "@/lib/orgs";
import { money, shortDate } from "@/lib/format";
import { PrintButton } from "./PrintButton";
import { TaxBreakdown } from "../Settlement";

/** Settlement summary / payment request between a store and a creator — the same data for both, never a tax document. */
export default async function Statement({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp);
  const { sb, org, status, t, locale, dir } = ctx;
  if (!status.is_admin || !sp.with) redirect(`/app/money?org=${org.id}`);
  const isStore = org.type === "store";
  const [store, creator] = isStore ? [org.id, sp.with] : [sp.with, org.id];
  const { data, error } = await sb.rpc("creator_statement", { p_store: store, p_creator: creator, p_from: sp.from || null, p_to: sp.to || null });
  if (error || !data) redirect(`/app/money?org=${org.id}&error=forbidden`);
  const s = data as any; const p = t.pay; const b = s.balance;
  const m = (v: number | string) => money(Number(v), b.currency, locale);
  const isRequest = sp.kind === "request";
  const cls = s.creator_classification as string | null;
  return (
    <main className="container statement" dir={dir} style={{ padding: "24px 16px 64px", maxWidth: 820 }}>
      <p className="row between no-print"><Link href={`/app/money?org=${org.id}`}>← {t.money.title}</Link>
        <span className="row" style={{ gap: 8 }}><PrintButton label={p.print} /><a className="btn btn-ghost btn-sm" href={`/app/money/csv?org=${org.id}&with=${sp.with}`}>{p.csv}</a></span></p>
      <h1>{isRequest ? p.requestTitle : p.statementTitle}</h1>
      <p className="alert alert-warn small">{p.notTax}</p>
      <table className="t small"><tbody>
        <tr><td>{t.common.orgType.store}</td><td><b>{s.store.name}</b></td></tr>
        <tr><td>{t.common.orgType.creator}</td><td><b>{s.creator.name}</b></td></tr>
        <tr><td>{p.period}</td><td>{s.from ? shortDate(s.from, locale) : "—"} – {shortDate(s.to, locale)}</td></tr>
        <tr><td>{p.generated}</td><td>{shortDate(s.generated_at, locale)}</td></tr>
      </tbody></table>
      <section className="stats" style={{ marginTop: 16 }}>
        <div className="stat"><span>{p.sales}</span><b>{b.sales}</b></div>
        <div className="stat"><span>{p.pending}</span><b>{m(b.pending_minor)}</b></div>
        <div className="stat"><span>{p.approved}</span><b>{m(b.approved_minor)}</b></div>
        <div className="stat"><span>{p.reported}</span><b>{m(b.reported_minor)}</b></div>
        <div className="stat stat-money"><span>{p.outstanding}</span><b>{m(b.outstanding_minor)}</b></div>
      </section>
      {Number(b.outstanding_minor) > 0 && <TaxBreakdown t={t} b={{ ...b, ...s.tax }} m={(v) => m(v)} />}
      {Number(b.reported_minor) > 0 && <p className="small">{p.tx.transferredLine(m(s.tax.reported_base_minor), m(s.tax.reported_vat_minor), m(s.tax.withheld_minor), m(s.tax.transferred_minor))}</p>}
      {b.due_at && Number(b.outstanding_minor) > 0 && <p><b>{p.dueBy(shortDate(b.due_at, locale))}</b>{b.overdue ? ` · ${p.overdue}` : ""}</p>}
      {Number(b.balance_minor) < 0 && <p className="small">{p.credit}: {m(-Number(b.balance_minor))}</p>}
      <h2>{p.lines}</h2>
      <div className="table-wrap"><table className="t small"><thead><tr><th>{p.date}</th><th>{p.order}</th><th>{p.base}</th><th>{p.rate}</th><th>{p.commission}</th><th>{p.state}</th></tr></thead><tbody>
        {(s.lines as any[]).map((l, i) => (
          <tr key={i}><td>{shortDate(l.date, locale)}</td><td className="ltr">#{l.order}{l.type === "reversal" ? ` · ${p.entry.reversal}` : ""}</td>
            <td className="ltr">{m(l.base_minor)}</td><td className="ltr">{(l.rate_bps / 100).toFixed(1)}%</td><td className="ltr">{m(l.amount_minor)}</td>
            <td>{p.stateNames[l.state] ?? l.state}{l.approved_at ? ` · ${shortDate(l.approved_at, locale)}` : ""}</td></tr>))}
      </tbody></table></div>
      <h2>{p.payments}</h2>
      {(s.payments as any[]).length === 0 ? <p className="muted">—</p> : (
        <div className="table-wrap"><table className="t small"><thead><tr><th>{p.date}</th><th>{p.tx.base}</th><th>{p.tx.vat}</th><th>{p.tx.withholding}</th><th>{p.tx.transferred}</th><th>{t.money.method}</th><th>{t.money.reference}</th><th>{p.state}</th></tr></thead><tbody>
          {(s.payments as any[]).map((x) => (
            <tr key={x.id}><td>{shortDate(x.paid_on ?? x.reported_at, locale)}</td><td className="ltr">{m(x.amount_minor)}</td><td className="ltr">{x.tax_basis === "undetermined" ? p.tx.undetermined : m(x.vat_minor)}</td>
              <td className="ltr">{m(x.withholding_minor ?? 0)}{x.withholding_ref ? ` · ${x.withholding_ref}` : ""}</td><td className="ltr">{m(x.net_minor ?? x.amount_minor)}</td>
              <td>{t.money.methods[x.method] ?? x.method}</td><td className="ltr">{x.reference ?? ""}{(x.proofs ?? []).map((pr: any) => <> · <a key={pr.id} href={`/app/money/proof/${pr.id}?org=${org.id}`}>{pr.filename}</a></>)}</td>
              <td>{p.statuses[x.status] ?? x.status}</td></tr>))}
        </tbody></table></div>
      )}
      <h2>{p.taxTitle}</h2>
      <p>{p.tax[cls ?? "none"] ?? p.tax.none}</p>
      <p className="small muted">{t.lc.tax}</p>
    </main>
  );
}
