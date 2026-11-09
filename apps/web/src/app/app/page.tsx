import { AppShell, NextAction, PageHead, Stat, Alert } from "@/components/AppShell";
import { loadApp, type OrgStatus } from "@/lib/orgs";
import { date, money, pct, shortDate } from "@/lib/format";
import type { Dict } from "@/i18n/he";

type Sale = { external_order_id?: string; order_created_at: string; status?: string; partner?: string; store_name?: string; method: string;
  self_referral_suspected?: boolean; base_minor?: number; commission_minor: number };

function nextFor(s: OrgStatus, t: Dict, q: string) {
  const n = t.next;
  if (s.type === "store") {
    if (!s.is_admin) return null;
    if (!s.connected && !s.connection_pending) return { ...n.connect, href: `/app/connect${q}` };
    if (!s.connected) return { ...n.pending, href: `/app/connect${q}` };
    if (!s.standing_live) return { ...n.offer, href: `/app/offer${q}` };
    if (s.pending_applications > 0) return { ...n.applications, t: n.applications.t(s.pending_applications), href: `/app/partners${q}` };
    if (s.partners === 0) return { ...n.invite, href: `/app/invite${q}` };
    if (s.open_invoices > 0) return { ...n.invoice, href: `/app/money${q}` };
    if (s.approved_unpaid_minor > 0) return { ...n.payCreators, href: `/app/money${q}` };
    if (s.sales === 0) return { ...n.waitSale, href: `/app/offer${q}#launch` };
    return { ...n.growStore, href: `/app/rewards${q}` };
  }
  if (s.payouts_to_confirm > 0) return { ...n.confirmPayout, href: `/app/money${q}` };
  if (s.partners === 0) return { ...n.catalog, href: `/app/catalog${q}` };
  if (s.sales === 0) return { ...n.share, href: `/app/partnerships${q}` };
  return { ...n.inviteStore, href: `/app/invite${q}` };
}

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp);
  const { sb, org, status, t, locale } = ctx;
  const q = `?org=${org.id}`;
  const { data } = await sb.rpc("org_dashboard", { p_org: org.id });
  const d = (data ?? {}) as Record<string, any>;
  const next = nextFor(status, t, q);
  const sales = (d.recent_sales ?? []) as Sale[];
  const cur = d.currency ?? "ILS";
  // Never show a row of zeros: stats appear once there is real money to show.
  const hasMoney = [d.month_sales_minor, d.approved_commissions_minor, d.pending_commissions_minor, d.month_platform_fee_minor,
    d.month_earnings_minor, d.pending_minor, d.approved_minor].some((v) => Number(v ?? 0) !== 0);

  return (
    <AppShell ctx={ctx} active="home" path="/app">
      <PageHead title={org.name} lead={org.type === "store" && d.founders_until ? t.dash.founders(date(d.founders_until, locale)) : undefined} />
      {sp.accepted && <Alert kind="ok" text={t.dash.accepted} />}
      {next && <NextAction eyebrow={t.next.title} title={next.t} text={next.d} cta={next.cta} href={next.href} />}

      {status.sales > 0 && (org.type === "store" || status.is_admin) && hasMoney && (
        <section className="section stats">
          {org.type === "store" ? (
            <>
              <Stat label={t.dash.salesMonth} value={money(d.month_sales_minor, cur, locale)} />
              <Stat label={t.dash.partners} value={d.active_partners} />
              {status.is_admin && <Stat label={t.dash.approvedComm} value={money(d.approved_commissions_minor, cur, locale)} />}
              {status.is_admin && <Stat label={t.dash.feeMonth} value={money(d.month_platform_fee_minor, cur, locale)} />}
            </>
          ) : (
            <>
              <Stat money label={t.dash.earningsMonth} value={money(d.month_earnings_minor, cur, locale)} />
              <Stat label={t.dash.pending} value={money(d.pending_minor, cur, locale)} />
              <Stat label={t.dash.approved} value={money(d.approved_minor, cur, locale)} />
              <Stat label={t.dash.stores} value={d.active_stores} />
            </>
          )}
        </section>
      )}

      {org.type === "store" && d.connection && (
        <p className="small muted section row">
          <span className={`dot${d.connection.status === "connected" ? "" : " dot-off"}`} />
          {t.dash.connection[d.connection.status]} · <span className="ltr">{d.connection.site_url}</span>
          {d.connection.last_sync_at && <> · {t.dash.connection.lastSync}: {shortDate(d.connection.last_sync_at, locale)}</>}
        </p>
      )}

      {(status.partners > 0 || status.sales > 0) && (
        <section className="section">
          <div className="section-head"><h2>{t.dash.recentSales}</h2></div>
          {sales.length === 0 ? <p className="empty">{t.dash.noSalesYet}</p> : (
            <div className="list">
              {sales.map((s, i) => (
                <div className="item" key={i}>
                  <div className="grow">
                    <div className="title">{org.type === "store" ? s.partner : s.store_name}
                      {s.self_referral_suspected && <> <span className="badge badge-warn">{t.dash.selfSuspect}</span></>}</div>
                    <div className="meta">{shortDate(s.order_created_at, locale)} · {t.dash.via[s.method]}
                      {s.external_order_id && <> · #{s.external_order_id}</>}
                      {s.status && <> · {t.orderStatus[s.status] ?? s.status}</>}</div>
                  </div>
                  <div className="amount">{money(s.commission_minor, cur, locale)}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {org.type === "store" && (d.partners ?? []).length > 0 && (
        <section className="section">
          <div className="section-head"><h2>{t.dash.partners}</h2></div>
          <div className="list">
            {(d.partners as { name: string; code: string; commission_bps: number }[]).slice(0, 5).map((p) => (
              <div className="item" key={p.code}><span className="title">{p.name}</span>
                <span className="row"><span className="badge mono">{p.code}</span><span className="badge badge-money">{pct(p.commission_bps, locale)}</span></span></div>
            ))}
          </div>
        </section>
      )}
    </AppShell>
  );
}
