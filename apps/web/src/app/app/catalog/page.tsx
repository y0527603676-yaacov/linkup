import Link from "next/link";
import { AppShell, PageHead, Alert } from "@/components/AppShell";
import { loadApp } from "@/lib/orgs";
import { errorText, money, pct, shortDate } from "@/lib/format";
import { joinOpportunity } from "../actions";

type Item = { id: string; kind: string; title: string; description: string | null; commission_bps: number; coupon_discount_pct: number;
  ends_at: string | null; auto_approve: boolean; store_org_id: string; store_name: string; store_url: string | null; product_count: number;
  products: { id: string; name: string; image_url: string | null; price_minor: number | null; currency: string }[] };

export default async function Catalog({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp, "creator");
  const { sb, org, t, locale } = ctx;
  const c = t.catalog;
  const kind = sp.kind === "campaign" || sp.kind === "standing" ? sp.kind : null;
  const [{ data }, { data: mine }] = await Promise.all([
    sb.rpc("catalog", { p_search: sp.q ?? null, p_kind: kind, p_limit: 60 }),
    sb.from("opportunity_applications").select("opportunity_id, status").eq("creator_org_id", org.id),
  ]);
  const items = (data ?? []) as Item[];
  const { data: ags } = await sb.from("agreements").select("store_org_id").eq("creator_org_id", org.id).eq("status", "active");
  const partnerStores = new Set((ags ?? []).map((a) => a.store_org_id));
  const state = (o: Item) => (mine ?? []).find((m) => m.opportunity_id === o.id)?.status ?? (o.kind === "standing" && partnerStores.has(o.store_org_id) ? "approved" : null);
  const base = `/app/catalog?org=${org.id}`;
  return (
    <AppShell ctx={ctx} active="catalog" path="/app/catalog">
      <PageHead title={c.title} lead={c.lead} />
      <Alert text={errorText(sp.error, t)} />
      {sp.ok === "pending" && <Alert kind="ok" text={c.pendingToast} />}
      <form className="row" style={{ marginBottom: 12 }} action="/app/catalog">
        <input type="hidden" name="org" value={org.id} />
        <input name="q" defaultValue={sp.q ?? ""} placeholder={c.search} aria-label={c.search} className="grow" style={{ flex: 1 }} />
      </form>
      <nav className="tabs" aria-label={c.title}>
        <Link className={`tab${!kind ? " on" : ""}`} href={base}>{c.all}</Link>
        <Link className={`tab${kind === "campaign" ? " on" : ""}`} href={`${base}&kind=campaign`}>{c.campaigns}</Link>
        <Link className={`tab${kind === "standing" ? " on" : ""}`} href={`${base}&kind=standing`}>{c.standing}</Link>
      </nav>
      {items.length === 0 ? (
        <div className="empty stack" style={{ alignItems: "center", gap: 10 }}>
          <span>{sp.q ? c.empty : c.emptyInvite}</span>
          <Link className="btn btn-primary btn-sm" href={`/app/invite?org=${org.id}`}>{t.next.inviteStore.cta}</Link>
        </div>) : (
        <div className="opps">
          {items.map((o) => {
            const st = state(o);
            return (
              <article className="opp" key={o.id}>
                <div className="thumbs" aria-hidden>
                  {[0, 1, 2, 3].map((i) => o.products[i]?.image_url
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img key={i} src={o.products[i]!.image_url!} alt="" loading="lazy" />
                    : <span key={i} />)}
                </div>
                <div className="body">
                  <div className="row between"><b>{o.store_name}</b>{o.kind === "campaign" && <span className="badge badge-accent">LAUNCH</span>}</div>
                  <span className="small">{o.title}</span>
                  {o.description && <span className="small muted">{o.description.slice(0, 140)}</span>}
                  <div className="row">
                    <span className="badge badge-money">{t.creators.commission} {pct(o.commission_bps, locale)}</span>
                    <span className="badge">{t.creators.discount} {o.coupon_discount_pct}%</span>
                  </div>
                  <span className="small muted">{c.products(o.product_count)}{o.products[0]?.price_minor != null ? ` · ${money(o.products[0]!.price_minor, o.products[0]!.currency, locale)}` : ""}
                    {o.ends_at ? ` · ${c.ends(shortDate(o.ends_at, locale))}` : ""} · {o.auto_approve ? c.instant : c.manual}</span>
                  <div style={{ marginTop: "auto", paddingTop: 8 }}>
                    {st === "approved" ? <span className="badge badge-money">{c.joined}</span>
                      : st === "pending" ? <span className="badge badge-warn">{c.pending}</span>
                      : st === "rejected" ? null
                      : <form action={joinOpportunity}><input type="hidden" name="org" value={org.id} /><input type="hidden" name="id" value={o.id} />
                          <label className="row small" style={{ alignItems: "flex-start", gap: 6, marginBottom: 6 }}><input type="checkbox" name="collab" value="1" required style={{ width: "auto", marginTop: 3 }} /><span>{t.lc.collab} <a href="/legal/commissions" target="_blank" rel="noopener">{t.legal.title}</a></span></label>
                          <button className="btn btn-primary btn-sm btn-block">{o.auto_approve ? c.join : c.request}</button></form>}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
      <p className="small muted" style={{ marginTop: 12 }}>{t.offer.vatNote}</p>
    </AppShell>
  );
}
