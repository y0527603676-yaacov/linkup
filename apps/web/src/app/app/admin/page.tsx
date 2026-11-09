import { redirect } from "next/navigation";
import { AppShell, PageHead, Alert, Stat } from "@/components/AppShell";
import { loadApp } from "@/lib/orgs";
import { errorText, money, shortDate } from "@/lib/format";
import { adminAction } from "../actions";

export default async function Admin({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp);
  const { sb, org, isPlatformAdmin, t, locale } = ctx;
  if (!isPlatformAdmin) redirect(`/app?org=${org.id}`);
  const a = t.admin;
  const { data } = await sb.rpc("admin_overview");
  const d = data as Record<string, any>;
  const prev = new Date(); prev.setUTCDate(1); prev.setUTCMonth(prev.getUTCMonth() - 1);
  const period = prev.toISOString().slice(0, 10);
  const H = ({ children }: { children: string }) => <div className="section-head"><h2>{children}</h2></div>;
  const hidden = <input type="hidden" name="org" value={org.id} />;
  const funnelOrder = ["signup", "activity_added", "store_connected", "products_synced", "opportunity_published", "invite_sent", "invite_opened",
    "proposal_accepted", "opportunity_joined", "first_attributed_sale", "campaign_launched", "creative_shared", "referral_link_shared", "referral_signup", "invoice_paid", "reward_earned"];
  return (
    <AppShell ctx={ctx} active="admin" path="/app/admin">
      <PageHead title={a.title} />
      <Alert text={errorText(sp.error, t)} />
      {sp.ok && <Alert kind="ok" text={t.common.saved} />}
      <section className="stats">
        <Stat label={a.stores} value={d.stores} /><Stat label={a.creators} value={d.creators} /><Stat label={a.connected} value={d.connected_stores} />
        <Stat label={a.sales30} value={d.attributed_sales_30d} /><Stat label={a.feesPending} value={money(d.platform_fees_pending_minor, "ILS", locale)} />
        <Stat label={a.uninvoiced} value={money(d.platform_fees_uninvoiced_minor, "ILS", locale)} /><Stat label={a.openInv} value={money(d.invoices_open_minor, "ILS", locale)} />
        <Stat money label={a.paidInv} value={money(d.invoices_paid_minor, "ILS", locale)} /><Stat label={a.rewards} value={money(d.rewards_earned_minor, "ILS", locale)} />
        <Stat label={a.suspected} value={d.suspected_self_referrals} /><Stat label={a.blocked} value={d.blocked_referrals} />
      </section>

      <section className="section"><H>{a.funnel}</H>
        <div className="table-wrap card card-flat"><table className="t"><thead><tr><th /><th>30d</th><th>Σ</th></tr></thead><tbody>
          {funnelOrder.map((k) => <tr key={k}><td>{a.events[k]}</td><td>{d.funnel?.[k]?.last_30d ?? 0}</td><td>{d.funnel?.[k]?.total ?? 0}</td></tr>)}
        </tbody></table></div>
      </section>

      {(d.silent_connections ?? []).length > 0 && (
        <section className="section"><H>{a.silent}</H>
          <div className="list">{d.silent_connections.map((c: any, i: number) => <div className="item" key={i}><span className="title">{c.org}</span><span className="meta ltr">{c.site_url} · {shortDate(c.last_sync_at, locale)}</span></div>)}</div>
        </section>
      )}

      <section className="section"><H>{a.invoices}</H>
        <form action={adminAction} className="row" style={{ marginBottom: 12 }}>{hidden}<input type="hidden" name="op" value="generate" />
          <input type="date" name="period" defaultValue={period} style={{ width: "auto" }} /><button className="btn btn-primary btn-sm">{a.generate}</button></form>
        <div className="list">
          {(d.invoices ?? []).map((i: any) => (
            <div className="item" key={i.id}>
              <div className="grow"><div className="title">#{i.number} · {i.store}</div><div className="meta">{i.period_start} · {money(i.fees_minor, i.currency, locale)}{Number(i.credit_minor) ? ` − ${money(i.credit_minor, i.currency, locale)}` : ""}{i.paid_reference ? ` · ${i.paid_reference}` : ""}</div></div>
              <span className="amount">{money(i.total_minor, i.currency, locale)}</span>
              {i.status === "issued" ? (
                <form action={adminAction} className="row">{hidden}<input type="hidden" name="id" value={i.id} />
                  <input name="reference" placeholder="Grow ref" style={{ width: 130 }} />
                  <button className="btn btn-primary btn-sm" name="op" value="paid">{a.markPaid}</button>
                  <button className="btn btn-danger btn-sm" name="op" value="void">{a.void}</button></form>
              ) : <span className="badge">{t.money.status[i.status]}</span>}
            </div>
          ))}
        </div>
      </section>

      {(d.rewards_owed ?? []).length > 0 && (
        <section className="section"><H>{a.owed}</H>
          <div className="list">{d.rewards_owed.map((r: any) => (
            <div className="item" key={r.org_id}><span className="title">{r.name}</span><span className="amount">{money(r.balance_minor, "ILS", locale)}</span>
              <form action={adminAction} className="row">{hidden}<input type="hidden" name="target" value={r.org_id} /><input name="reference" placeholder="ref" style={{ width: 110 }} />
                <button className="btn btn-ghost btn-sm" name="op" value="transfer">{a.transfer}</button></form></div>))}</div>
        </section>
      )}

      <section className="section"><H>{a.orgs}</H>
        <div className="list">{(d.recent_orgs ?? []).map((o: any) => (
          <div className="item" key={o.id}><div className="grow"><div className="title">{o.name} <span className="badge">{t.common.orgType[o.type]}</span>{o.connected && <> <span className="badge badge-money">✓</span></>}</div>
            <div className="meta">{shortDate(o.created_at, locale)} · {t.nav.partners}: {o.partners} · {t.dash.recentSales}: {o.sales}{o.referred_by ? ` · ← ${o.referred_by}` : ""}</div></div></div>))}</div>
      </section>

      <section className="section"><H>{a.settings}</H>
        <div className="list">{["founding_partners_open", "founders_open"].map((k) => (
          <form action={adminAction} className="item" key={k}>{hidden}<input type="hidden" name="op" value="setting" /><input type="hidden" name="key" value={k} />
            <span className="title mono">{k}</span>
            <select name="value" defaultValue={String(d.settings?.[k])} style={{ width: "auto" }}><option value="true">true</option><option value="false">false</option></select>
            <button className="btn btn-ghost btn-sm">{t.common.save}</button></form>))}</div>
      </section>
    </AppShell>
  );
}
