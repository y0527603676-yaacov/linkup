import { AppShell, PageHead, Alert } from "@/components/AppShell";
import { loadApp } from "@/lib/orgs";
import { errorText } from "@/lib/format";
import { createInvite } from "../actions";

export default async function Invite({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp);
  const { org, t } = ctx;
  const i = t.invite;
  const isStore = org.type === "store";
  const { data: std } = isStore ? await ctx.sb.from("opportunities").select("commission_bps, coupon_discount_pct").eq("store_org_id", org.id).eq("kind", "standing").maybeSingle() : { data: null };
  return (
    <AppShell ctx={ctx} active={isStore ? "partners" : "partnerships"} path="/app/invite">
      <div className="narrow">
        <PageHead title={isStore ? i.storeTitle : i.creatorTitle} lead={isStore ? i.storeLead : i.creatorLead} />
        <Alert text={errorText(sp.error, t)} />
        <form action={createInvite} className="card stack">
          <input type="hidden" name="org" value={org.id} />
          <label className="field"><span>{i.name}</span><input name="name" maxLength={120} autoFocus /></label>
          <label className="field"><span>{i.contact} <small>({t.common.optional})</small></span><input name="contact" maxLength={200} dir="ltr" /></label>
          {!isStore && <label className="field"><span>{i.site}</span><input name="site" dir="ltr" inputMode="url" placeholder="theirshop.co.il" /></label>}
          <div className="fields-2">
            <label className="field"><span>{i.commission}</span><input name="commission" type="number" min={1} max={50} step={0.5} defaultValue={(std?.commission_bps ?? 1000) / 100} required /></label>
            <label className="field"><span>{i.discount}</span><input name="discount" type="number" min={0} max={50} step={1} defaultValue={std?.coupon_discount_pct ?? 10} required /></label>
          </div>
          <button className="btn btn-primary btn-block">{i.send}</button>
        </form>
      </div>
    </AppShell>
  );
}
