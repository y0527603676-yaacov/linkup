import { cookies } from "next/headers";
import Link from "next/link";
import { AppShell, PageHead, Alert } from "@/components/AppShell";
import { CopyButton } from "@/components/CopyButton";
import { LegalChecks, type PendingDoc } from "@/components/LegalChecks";
import { loadApp } from "@/lib/orgs";
import { errorText, shortDate } from "@/lib/format";
import { getOrigin } from "@/lib/supabase/server";
import { createPlatformConnection } from "../../actions";

/** Custom site: the owner creates a key for the developer; the developer connects the site once (signed API). */
export default async function ConnectApi({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp, "store");
  const { sb, org, t, locale } = ctx;
  const u = t.uc; const a = u.apiPage;
  const [{ data: conns }, { data: o }, { data: pend }] = await Promise.all([
    sb.from("store_connections").select("status, site_url, last_sync_at").eq("org_id", org.id).eq("method", "signed_api").order("created_at", { ascending: false }).limit(1),
    sb.from("organizations").select("website_url").eq("id", org.id).single(),
    sb.rpc("legal_pending", { p_context: "store" }),
  ]);
  const c = conns?.[0] as { status: string; site_url: string; last_sync_at: string | null } | undefined;
  const key = sp.ok === "created" ? (await cookies()).get("lk_api_key")?.value : undefined;
  const guide = `${await getOrigin()}/developers`;
  return (
    <AppShell ctx={ctx} active="settings" path="/app/connect/api">
      <div className="narrow">
        <PageHead title={a.title} lead={a.lead} />
        <Alert text={errorText(sp.error, t)} />
        <ol className="small" style={{ paddingInlineStart: 18 }}>{a.steps.map((s) => <li key={s}>{s}</li>)}</ol>

        {key && (
          <section className="card stack" style={{ marginBottom: 16 }}>
            <h2 style={{ margin: 0 }}>{a.keyTitle}</h2>
            <p className="alert alert-warn small" style={{ margin: 0 }}>{a.keyOnce}</p>
            <div className="keybox" dir="ltr">{key}</div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <CopyButton text={key} label={t.connect.copyKey} done={t.common.copied} className="btn btn-primary btn-sm" />
              <CopyButton text={a.devMsg(key, guide)} label={a.forDev} done={t.common.copied} />
            </div>
          </section>
        )}

        {c && (
          <div className="card card-flat stack" style={{ marginBottom: 16, gap: 6 }}>
            <p className="row" style={{ margin: 0 }}><span className={`dot${c.status === "connected" ? "" : " dot-off"}`} />
              <b>{c.status === "connected" ? a.statusOk : a.statusPending}</b> · <span className="ltr">{c.site_url}</span></p>
            {c.last_sync_at && <p className="small muted" style={{ margin: 0 }}>{a.lastSeen}: {shortDate(c.last_sync_at, locale)}</p>}
          </div>
        )}

        <form action={createPlatformConnection} className="card stack">
          <input type="hidden" name="org" value={org.id} />
          <input type="hidden" name="kind" value="custom" />
          <label className="field"><span>{a.site}</span>
            <input name="site" required dir="ltr" inputMode="url" placeholder="myshop.co.il" defaultValue={sp.site ?? c?.site_url ?? o?.website_url ?? ""} /></label>
          <LegalChecks docs={(pend ?? []) as PendingDoc[]} locale={locale} label={t.lc.store} />
          <button className={c ? "btn btn-ghost" : "btn btn-primary"}>{c ? a.rotate : a.create}</button>
          {c && <p className="small muted" style={{ margin: 0 }}>{a.rotateNote}</p>}
        </form>

        <p className="small" style={{ marginTop: 16 }}><Link href="/developers" target="_blank">{a.guide} ↗</Link></p>
        <p className="small muted">{a.trust}</p>
      </div>
    </AppShell>
  );
}
