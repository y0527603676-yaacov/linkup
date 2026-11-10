import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell, PageHead, Alert } from "@/components/AppShell";
import { loadApp } from "@/lib/orgs";
import { errorText } from "@/lib/format";
import { updateOrg, saveTaxProfile } from "../actions";

export default async function Settings({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp);
  const { sb, org, status, t } = ctx;
  if (!status.is_admin) redirect(`/app?org=${org.id}`);
  const s = t.settings;
  const [{ data: o }, { data: tp }] = await Promise.all([
    sb.from("organizations").select("name, website_url, description, logo_url, locale").eq("id", org.id).single(),
    sb.from("tax_profiles").select("*").eq("org_id", org.id).maybeSingle(),
  ]);
  const x = t.taxp;
  return (
    <AppShell ctx={ctx} active="settings" path="/app/settings">
      <div className="narrow">
        <PageHead title={s.title} />
        <Alert text={errorText(sp.error, t)} />
        {sp.ok && <Alert kind="ok" text={s.saved} />}
        <form action={updateOrg} className="card stack">
          <input type="hidden" name="org" value={org.id} />
          <label className="field"><span>{s.name}</span><input name="name" required minLength={2} maxLength={80} defaultValue={o?.name} /></label>
          <label className="field"><span>{s.website}</span><input name="website" dir="ltr" inputMode="url" defaultValue={o?.website_url ?? ""} /></label>
          <label className="field"><span>{s.description}</span><textarea name="description" maxLength={500} defaultValue={o?.description ?? ""} /></label>
          <label className="field"><span>{s.logo}</span><input name="logo" dir="ltr" inputMode="url" defaultValue={o?.logo_url ?? ""} placeholder="https://" /></label>
          <label className="field"><span>{s.locale}</span>
            <select name="locale" defaultValue={o?.locale ?? "he"}><option value="he">עברית</option><option value="en">English</option></select></label>
          <button className="btn btn-primary">{t.common.save}</button>
        </form>
        <form action={saveTaxProfile} className="card stack section" id="tax">
          <input type="hidden" name="org" value={org.id} />
          <h2>{x.title}</h2>
          <p className="small muted">{x.lead}</p>
          <p className="small"><span className={`badge ${tp?.verified_at ? "badge-money" : "badge-warn"}`}>{!tp ? x.none : tp.verified_at ? x.verified : x.pending}</span></p>
          <label className="field"><span>{x.legalName}</span><input name="legal_name" required minLength={2} maxLength={200} defaultValue={tp?.legal_name ?? ""} /></label>
          <label className="field"><span>{x.classification}</span>
            <select name="classification" required defaultValue={tp?.classification ?? ""}><option value="" disabled>—</option>
              {Object.entries(x.classes).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field"><span>{x.taxId}</span><input name="tax_id" dir="ltr" maxLength={40} defaultValue={tp?.tax_id ?? ""} /></label>
          <label className="field"><span>{x.address}</span><input name="address" maxLength={300} defaultValue={tp?.address ?? ""} /></label>
          <label className="field"><span>{x.country}</span><input name="country" dir="ltr" maxLength={2} pattern="[A-Za-z]{2}" defaultValue={tp?.country ?? "IL"} /></label>
          <details><summary className="small">{x.foreignTitle}</summary>
            <div className="stack" style={{ marginTop: 8 }}>
              <label className="row small"><input type="checkbox" name="no_il" value="1" defaultChecked={tp?.foreign_no_il_presence ?? false} /> {x.noIl}</label>
              <label className="field"><span>{x.evidence}</span><input name="evidence" maxLength={500} defaultValue={tp?.foreign_evidence ?? ""} /></label>
              <label className="field"><span>{x.payMethod}</span><input name="payment_method" maxLength={200} defaultValue={tp?.foreign_payment_method ?? ""} /></label>
            </div></details>
          <p className="small muted">{x.resetNote} {tp?.classification === "private_individual" ? x.privateNote : ""}</p>
          <button className="btn btn-primary">{x.save}</button>
        </form>
        {org.type === "store" && <p className="section center"><Link href={`/app/connect?org=${org.id}`}>{t.connect.title}</Link> · <Link href={`/app/products?org=${org.id}`}>{t.nav.products}</Link></p>}
      </div>
    </AppShell>
  );
}
