import { AppShell, PageHead, Alert } from "@/components/AppShell";
import { ChoiceButton } from "@/components/ChoiceButton";
import { loadApp } from "@/lib/orgs";
import { errorText, pct, shortDate } from "@/lib/format";
import { saveOffer, createCampaign, setOpportunityStatus } from "../actions";
import { TzInput } from "@/components/TzInput";

type Opp = { id: string; kind: string; title: string; description: string | null; commission_bps: number; coupon_discount_pct: number;
  auto_approve: boolean; status: string; starts_at: string; ends_at: string | null; product_ids: string[] };

export default async function Offer({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp, "store");
  const { sb, org, status, t, locale } = ctx;
  const o = t.offer;
  const [{ data: opps }, { data: products }, { data: apps }] = await Promise.all([
    sb.from("opportunities").select("*").eq("store_org_id", org.id).order("created_at", { ascending: false }),
    sb.from("products").select("id, name, in_stock").eq("store_org_id", org.id).eq("status", "active").order("name").limit(200),
    sb.from("opportunity_applications").select("opportunity_id, status").eq("status", "approved"),
  ]);
  const all = (opps ?? []) as Opp[];
  const standing = all.find((x) => x.kind === "standing");
  const campaigns = all.filter((x) => x.kind === "campaign" && x.status !== "ended" && x.ends_at && new Date(x.ends_at) > new Date());
  const count = (id: string) => (apps ?? []).filter((a) => a.opportunity_id === id).length;
  const today = new Date().toISOString().slice(0, 10);
  const in7 = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const ro = !status.is_admin;

  return (
    <AppShell ctx={ctx} active="offer" path="/app/offer">
      <PageHead title={o.title} lead={o.lead}>
        {standing && <span className={`badge ${standing.status === "live" ? "badge-money" : ""}`}>{standing.status === "live" ? o.live : o.paused}</span>}
      </PageHead>
      <Alert text={errorText(sp.error, t)} />
      {sp.ok && <Alert kind="ok" text={t.common.saved} />}

      <form action={saveOffer} className="card stack">
        <input type="hidden" name="org" value={org.id} />
        <label className="field"><span>{o.formTitle}</span>
          <input name="title" required minLength={2} maxLength={100} defaultValue={standing?.title ?? org.name} placeholder={o.formTitlePh} disabled={ro} /></label>
        <label className="field"><span>{o.description}</span>
          <textarea name="description" maxLength={1000} defaultValue={standing?.description ?? ""} disabled={ro} /></label>
        <div className="fields-2">
          <label className="field"><span>{o.commission}</span>
            <input name="commission" type="number" min={1} max={50} step={0.5} required defaultValue={(standing?.commission_bps ?? 1000) / 100} disabled={ro} /></label>
          <label className="field"><span>{o.discount}</span>
            <input name="discount" type="number" min={0} max={50} step={1} required defaultValue={standing?.coupon_discount_pct ?? 10} disabled={ro} /></label>
        </div>
        <label className="check"><input type="checkbox" name="auto" defaultChecked={standing?.auto_approve ?? true} disabled={ro} />
          <span><b>{o.autoApprove}</b><br /><small className="muted">{o.autoApproveHelp}</small></span></label>
        {(products ?? []).length > 0 && (
          <details>
            <summary className="small"><b>{o.products}</b> · <span className="muted">{o.productsHelp}</span></summary>
            <div className="stack" style={{ marginTop: 8, maxHeight: 240, overflowY: "auto" }}>
              {(products ?? []).map((p) => (
                <label className="check small" key={p.id}><input type="checkbox" name="products" value={p.id} defaultChecked={standing?.product_ids?.includes(p.id)} disabled={ro} />{p.name}</label>
              ))}
            </div>
          </details>
        )}
        <p className="small muted">{o.termsNote}</p>
        {!ro && (
          <div className="row">
            <ChoiceButton className="btn btn-primary" name="status" value="live">{o.publish}</ChoiceButton>
            {standing?.status === "live" && <ChoiceButton className="btn btn-ghost" name="status" value="paused">{o.pause}</ChoiceButton>}
          </div>
        )}
      </form>

      <section className="section" id="launch">
        <div className="section-head"><h2>{o.campaignsTitle}</h2></div>
        <p className="muted">{o.campaignsLead}</p>
        {campaigns.length === 0 ? <p className="empty">{o.noCampaigns}</p> : (
          <div className="list">
            {campaigns.map((c) => (
              <div className="item" key={c.id}>
                <div className="grow"><div className="title">{c.title} <span className="badge badge-accent">{pct(c.commission_bps, locale)}</span></div>
                  <div className="meta">{shortDate(c.starts_at, locale)} – {shortDate(c.ends_at, locale)} · {o.participants}: {count(c.id)}</div></div>
                {!ro && <form action={setOpportunityStatus}><input type="hidden" name="org" value={org.id} /><input type="hidden" name="id" value={c.id} />
                  <ChoiceButton className="btn btn-danger btn-sm" name="status" value="ended">{o.end}</ChoiceButton></form>}
              </div>
            ))}
          </div>
        )}
        {!ro && (status.connected ? (
          <form action={createCampaign} className="card stack" style={{ marginTop: 16 }}>
            <h3>{o.newCampaign}</h3>
            <input type="hidden" name="org" value={org.id} />
            <TzInput />
            <label className="field"><span>{o.campaignTitle}</span><input name="title" required minLength={2} maxLength={100} placeholder={o.campaignTitlePh} /></label>
            <label className="field"><span>{o.description}</span><textarea name="description" maxLength={1000} /></label>
            <label className="field"><span>{o.campaignRate}</span>
              <input name="commission" type="number" min={1} max={50} step={0.5} required defaultValue={Math.min(50, (standing?.commission_bps ?? 1000) / 100 + 5)} /></label>
            <div className="fields-2">
              <label className="field"><span>{o.starts}</span><input name="starts" type="date" required defaultValue={today} min={today} /></label>
              <label className="field"><span>{o.ends}</span><input name="ends" type="date" required defaultValue={in7} min={today} /></label>
            </div>
            <p className="small muted">{o.campaignRule}</p>
            <button className="btn btn-primary">{o.create}</button>
          </form>
        ) : <p className="alert alert-warn">{o.needConnect}</p>)}
      </section>
    </AppShell>
  );
}
