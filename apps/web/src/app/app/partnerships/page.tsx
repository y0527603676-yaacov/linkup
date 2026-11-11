import Link from "next/link";
import { AppShell, PageHead, Alert } from "@/components/AppShell";
import { CopyButton } from "@/components/CopyButton";
import { loadApp } from "@/lib/orgs";
import { getOrigin } from "@/lib/supabase/server";
import { pct, shortDate } from "@/lib/format";

type P = { store_name: string; website_url: string | null; code: string | null; commission_bps: number; coupon_discount_pct: number; store_connected: boolean };

export default async function Partnerships({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp, "creator");
  const { sb, org, t, locale } = ctx;
  const l = t.partnerships;
  const origin = await getOrigin();
  const [{ data: dash }, { data: camps }, { data: stores }] = await Promise.all([
    sb.rpc("org_dashboard", { p_org: org.id }),
    sb.from("opportunity_applications").select("status, opportunities!inner(kind, title, commission_bps, ends_at, status, store_org_id, organizations(name))")
      .eq("creator_org_id", org.id).eq("status", "approved").eq("opportunities.kind", "campaign").eq("opportunities.status", "live"),
    sb.rpc("my_partner_stores", { p_creator: org.id }),
  ]);
  // How each store's sales reach LINKUP (shown so the creator knows what is tracked and what is reported).
  const tracking = new Map(((stores ?? []) as { store_name: string; tracking: string }[]).map((x) => [x.store_name, x.tracking]));
  const u = t.uc;
  const list = ((dash as any)?.partnerships ?? []) as P[];
  const live = ((camps ?? []) as any[]).map((c) => c.opportunities).filter((o) => o && new Date(o.ends_at) > new Date());
  return (
    <AppShell ctx={ctx} active="partnerships" path="/app/partnerships">
      <PageHead title={l.title} lead={l.lead}>
        <Link className="btn btn-ghost btn-sm" href={`/app/invite?org=${org.id}`}>{t.invite.creatorTitle}</Link>
        <Link className="btn btn-ghost btn-sm" href={`/app/claims?org=${org.id}`}>{u.claims.title}</Link>
      </PageHead>
      {(sp.accepted || sp.joined) && <Alert kind="ok" text={t.catalog.joinedToast} />}
      {list.length === 0 ? (
        <div className="empty"><p>{l.empty}</p><Link className="btn btn-primary" href={`/app/catalog?org=${org.id}`}>{t.nav.catalog}</Link></div>
      ) : (
        <div className="stack">
          {list.map((p) => {
            const link = p.code ? `${origin}/r/${p.code}` : "";
            const camp = live.find((c) => c.organizations?.name === p.store_name);
            return (
              <div className="card" key={p.code ?? p.store_name}>
                <div className="row between">
                  <h2 style={{ margin: 0 }}>{p.store_name}</h2>
                  <span className="row"><span className="badge badge-money">{l.rate} {pct(p.commission_bps, locale)}</span><span className="badge">{l.discount} {p.coupon_discount_pct}%</span></span>
                </div>
                {camp && <p className="badge badge-accent" style={{ marginTop: 8 }}>{l.campaign(pct(camp.commission_bps, locale), shortDate(camp.ends_at, locale))}</p>}
                {!p.store_connected && <p className="alert alert-warn small">{l.notConnected}</p>}
                {p.store_connected && tracking.get(p.store_name) && tracking.get(p.store_name) !== "none" && (
                  <p className="small" style={{ margin: "8px 0 0" }}><span className="badge">{u.tracking[tracking.get(p.store_name)!]}</span>
                    {u.trackingNote[tracking.get(p.store_name)!] && <span className="muted"> {u.trackingNote[tracking.get(p.store_name)!]}</span>}</p>
                )}
                {p.code && (
                  <div className="stack" style={{ marginTop: 12 }}>
                    <div className="row between"><span className="muted small">{l.code}</span><span className="row"><span className="codebig">{p.code}</span><CopyButton text={p.code} label={t.common.copy} done={t.common.copied} /></span></div>
                    <div className="row between"><span className="muted small">{l.link}</span><span className="row"><span className="ltr small">{link.replace(/^https?:\/\//, "")}</span><CopyButton text={link} label={t.common.copy} done={t.common.copied} /></span></div>
                    <Link className="btn btn-primary" href={`/app/share?org=${org.id}&code=${p.code}`}>{l.create}</Link>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}
