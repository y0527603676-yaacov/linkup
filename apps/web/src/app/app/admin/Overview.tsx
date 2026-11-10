import Link from "next/link";
import { money, shortDate } from "@/lib/format";
type Loc = "he" | "en";
import type { Dict } from "@/i18n/he";
import { Stat } from "@/components/AppShell";

type Step = { step: string; n: number };
type O = {
  include_test: boolean; test_orgs: number;
  kpi: Record<string, number>; store_funnel: Step[]; creator_funnel: Step[]; engines: Record<string, number>;
  bottlenecks: { connected_no_offer: { id: string; name: string }[]; not_connected_2d: { id: string; name: string; since: string }[];
    connection_problems: { id: string; name: string; error: string | null; last_sync_at: string | null }[]; creators_no_partner_3d: number; pending_applications: number };
  readiness: Record<string, number | boolean | string | null>;
};

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

/** Funnel as bars: each step's width relative to the first step, with step-to-step conversion. */
function Funnel({ steps, label }: { steps: Step[]; label: Record<string, string> }) {
  const top = Math.max(steps[0]?.n ?? 0, 1);
  return (
    <ol className="funnel" role="list">
      {steps.map((s, i) => (
        <li key={s.step}>
          <div className="funnel-row"><span>{label[s.step] ?? s.step}</span><b>{s.n}</b>
            {i > 0 && <span className="small muted">{pct(s.n, steps[i - 1]!.n)}</span>}</div>
          <div className="funnel-bar" aria-hidden><i style={{ width: `${Math.max(2, (s.n / top) * 100)}%` }} /></div>
        </li>
      ))}
    </ol>
  );
}

export function Overview({ o, a, locale: loc, orgParam }: { o: O; a: Dict["admin"]; locale: string; orgParam: string }) {
  const locale = loc as Loc;
  const k = o.kpi; const e = o.engines; const b = o.bottlenecks; const r = o.readiness;
  const tasks = [
    ...b.connection_problems.map((x) => ({ key: `cp${x.id}`, text: a.ov.taskConn(x.name) })),
    ...b.connected_no_offer.map((x) => ({ key: `no${x.id}`, text: a.ov.taskNoOffer(x.name) })),
    ...b.not_connected_2d.map((x) => ({ key: `nc${x.id}`, text: a.ov.taskNotConnected(x.name, shortDate(x.since, locale)) })),
    ...(b.pending_applications ? [{ key: "pa", text: a.ov.taskApplications(b.pending_applications) }] : []),
    ...(b.creators_no_partner_3d ? [{ key: "cn", text: a.ov.taskCreators(b.creators_no_partner_3d) }] : []),
  ];
  const ready: [string, boolean, string][] = [
    [a.ov.rLegal, Number(r.legal_published) > 0, Number(r.legal_published) > 0 ? a.ov.rLegalOk(Number(r.legal_published)) : a.ov.rLegalNo(Number(r.legal_drafts))],
    [a.ov.rStores, Number(r.real_connected_stores) > 0, String(r.real_connected_stores)],
    [a.ov.rInvoicing, r.invoicing_tax_approved === true, r.invoicing_tax_approved ? a.ov.on : a.ov.off],
    [a.ov.rCollection, r.auto_collection_enabled === true, `${r.auto_collection_enabled ? a.ov.on : a.ov.off} · ${r.billing_provider}`],
    [a.ov.rRewards, r.reward_settlement_approved === true, r.reward_settlement_approved ? a.ov.on : a.ov.off],
    [a.ov.rApi, r.woo_api_connect_open === true, r.woo_api_connect_open ? a.ov.rApiOpen : a.ov.rApiBeta],
  ];
  return (
    <>
      <p className="small muted" style={{ margin: "0 0 12px" }}>
        {o.include_test ? a.ov.withTest : a.ov.realOnly(o.test_orgs)}{" "}
        <Link href={`/app/admin?org=${orgParam}${o.include_test ? "" : "&test=1"}`}>{o.include_test ? a.ov.showReal : a.ov.showTest}</Link>
      </p>
      <section className="stats">
        <Stat label={a.ov.kpi.stores} value={k.stores} /><Stat label={a.ov.kpi.creators} value={k.creators} />
        <Stat label={a.ov.kpi.connected} value={k.connected_stores} /><Stat label={a.ov.kpi.offers} value={k.live_offers} />
        <Stat label={a.ov.kpi.partnerships} value={k.active_partnerships} /><Stat label={a.ov.kpi.sales} value={`${k.attributed_sales} · ${a.ov.last30(k.attributed_sales_30d ?? 0)}`} />
        <Stat label={a.ov.kpi.fees} value={money(k.linkup_fees_accrued_minor ?? 0, "ILS", locale)} />
        <Stat money label={a.ov.kpi.collected} value={money(k.linkup_collected_minor ?? 0, "ILS", locale)} />
      </section>

      <section className="section"><div className="section-head"><h2>{a.ov.tasks}</h2></div>
        {tasks.length === 0 ? <p className="empty">{a.ov.noTasks}</p>
          : <ul className="list">{tasks.map((x) => <li className="item" key={x.key}><span className="title">{x.text}</span></li>)}</ul>}
      </section>

      <section className="section split">
        <div><div className="section-head"><h2>{a.ov.storeFunnel}</h2></div><Funnel steps={o.store_funnel} label={a.ov.steps} /></div>
        <div><div className="section-head"><h2>{a.ov.creatorFunnel}</h2></div><Funnel steps={o.creator_funnel} label={a.ov.steps} /></div>
      </section>

      <section className="section"><div className="section-head"><h2>{a.ov.engines}</h2></div>
        <div className="table-wrap card card-flat"><table className="t"><tbody>
          <tr><td>{a.ov.eInvites}</td><td>{e.invites_sent} → {e.invites_opened} → {e.invites_accepted}</td><td className="muted">{pct(e.invites_accepted ?? 0, e.invites_sent ?? 0)}</td></tr>
          <tr><td>{a.ov.eStoreInvites}</td><td>{e.store_invites_by_creators}</td><td /></tr>
          <tr><td>{a.ov.eReferrals}</td><td>{e.referral_links_shared} → {e.referral_signups}</td><td className="muted">{pct(e.referral_signups ?? 0, e.referral_links_shared ?? 0)}</td></tr>
          <tr><td>{a.ov.eCatalog}</td><td>{e.catalog_joins}</td><td /></tr>
        </tbody></table></div>
      </section>

      <section className="section"><div className="section-head"><h2>{a.ov.readiness}</h2></div>
        <ul className="list">{ready.map(([label, ok, detail]) => (
          <li className="item" key={label}><span aria-hidden>{ok ? "✅" : "⏸️"}</span><span className="title grow">{label}</span><span className="meta">{detail}</span></li>))}</ul>
      </section>
    </>
  );
}
