import { AppShell, PageHead } from "@/components/AppShell";
import { loadApp } from "@/lib/orgs";
import { shortDate } from "@/lib/format";
import { ConnectForm } from "./ConnectForm";
import type { PendingDoc } from "@/components/LegalChecks";

export default async function Connect({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await loadApp(await searchParams, "store");
  const { sb, org, t, locale } = ctx;
  const { data: conns } = await sb.from("store_connections").select("status, site_url, last_sync_at, plugin_version").eq("org_id", org.id).order("created_at", { ascending: false }).limit(1);
  const c = conns?.[0];
  const { data: o } = await sb.from("organizations").select("website_url").eq("id", org.id).single();
  const { data: pend } = await sb.rpc("legal_pending", { p_context: "store" });
  return (
    <AppShell ctx={ctx} active="settings" path="/app/connect">
      <div className="narrow">
        <PageHead title={t.connect.title} lead={t.connect.lead} />
        {c && (
          <div className="card card-flat" style={{ marginBottom: 16 }}>
            <p className="row"><span className={`dot${c.status === "connected" ? "" : " dot-off"}`} /><b>{t.dash.connection[c.status]}</b> · <span className="ltr">{c.site_url}</span></p>
            {c.last_sync_at && <p className="small muted">{t.dash.connection.lastSync}: {shortDate(c.last_sync_at, locale)}{c.plugin_version ? ` · v${c.plugin_version}` : ""}</p>}
            {c.status === "connected" && <p className="small muted">{t.connect.rotateNote}</p>}
          </div>
        )}
        <ConnectForm orgId={org.id} l={t.connect} errors={t.errors} defaultSite={c?.site_url ?? o?.website_url ?? ""} rotate={c?.status === "connected"}
          legal={(pend ?? []) as PendingDoc[]} locale={locale} legalLead={t.lc.store} />
      </div>
    </AppShell>
  );
}
