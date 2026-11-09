import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell, PageHead, Alert } from "@/components/AppShell";
import { loadApp } from "@/lib/orgs";
import { errorText } from "@/lib/format";
import { updateOrg } from "../actions";

export default async function Settings({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp);
  const { sb, org, status, t } = ctx;
  if (!status.is_admin) redirect(`/app?org=${org.id}`);
  const s = t.settings;
  const { data: o } = await sb.from("organizations").select("name, website_url, description, logo_url, locale").eq("id", org.id).single();
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
        {org.type === "store" && <p className="section center"><Link href={`/app/connect?org=${org.id}`}>{t.connect.title}</Link> · <Link href={`/app/products?org=${org.id}`}>{t.nav.products}</Link></p>}
      </div>
    </AppShell>
  );
}
