import { AppShell, PageHead, Alert } from "@/components/AppShell";
import { loadApp } from "@/lib/orgs";
import { errorText, shortDate } from "@/lib/format";
import { ConnectForm } from "./ConnectForm";
import { LegalChecks, type PendingDoc } from "@/components/LegalChecks";
import { startWooApi, syncWooApi } from "../actions";

export default async function Connect({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp, "store");
  const { sb, org, t, locale } = ctx;
  const l = t.connect;
  const [{ data: conns }, { data: o }, { data: pend }, { data: apiOpen }] = await Promise.all([
    sb.from("store_connections").select("status, site_url, last_sync_at, plugin_version, method, last_error").eq("org_id", org.id).order("created_at", { ascending: false }).limit(1),
    sb.from("organizations").select("website_url").eq("id", org.id).single(),
    sb.rpc("legal_pending", { p_context: "store" }),
    sb.rpc("woo_api_available", { p_org: org.id }),
  ]);
  const c = conns?.[0] as { status: string; site_url: string; last_sync_at: string | null; plugin_version: string | null; method: string; last_error: string | null } | undefined;
  const legal = (pend ?? []) as PendingDoc[];
  const site = c?.site_url ?? o?.website_url ?? "";
  const api = apiOpen === true;
  const connected = c?.status === "connected";
  return (
    <AppShell ctx={ctx} active="settings" path="/app/connect">
      <div className="narrow">
        <PageHead title={l.title} lead={api ? l.leadApi : l.lead} />
        <Alert text={errorText(sp.error, t)} />
        {sp.ok === "sync" && <Alert kind="ok" text={l.syncStarted} />}

        {c && (
          <div className="card card-flat stack" style={{ marginBottom: 16, gap: 6 }}>
            <p className="row" style={{ margin: 0 }}><span className={`dot${connected && !c.last_error ? "" : " dot-off"}`} /><b>{t.dash.connection[c.status]}</b> · <span className="ltr">{c.site_url}</span></p>
            <p className="small muted" style={{ margin: 0 }}>{c.method === "api" ? l.viaApi : l.viaPlugin}
              {c.last_sync_at ? ` · ${t.dash.connection.lastSync}: ${shortDate(c.last_sync_at, locale)}` : ""}
              {c.method === "plugin" && c.plugin_version ? ` · v${c.plugin_version}` : ""}</p>
            {c.last_error && <p className="alert alert-warn small" style={{ margin: 0 }}>{l.errors[c.last_error] ?? l.errors.other}</p>}
            {c.method === "api" && c.status !== "disconnected" && (
              <form action={syncWooApi}><input type="hidden" name="org" value={org.id} /><button className="btn btn-ghost btn-sm">{l.syncNow}</button></form>
            )}
          </div>
        )}

        <section className="stack">
          <h2 style={{ margin: "8px 0 0" }}>{l.platformTitle}</h2>
          <div className="platforms">
            <span className="platform on">WooCommerce</span>
            {["Shopify", "Wix", "Magento"].map((p) => <span className="platform" key={p}>{p} <small>{l.soon}</small></span>)}
          </div>
          <p className="small muted" style={{ margin: 0 }}>{l.otherPlatform} <a href="/contact">{l.tellUs}</a></p>
        </section>

        {api && !(c?.method === "api" && connected) && (
          <form action={startWooApi} className="card stack" style={{ marginTop: 16 }}>
            <input type="hidden" name="org" value={org.id} />
            <div className="row between" style={{ alignItems: "baseline" }}><h3 style={{ margin: 0 }}>{l.apiTitle}</h3><span className="badge badge-brand">{l.recommended}</span></div>
            <ol className="small" style={{ margin: 0, paddingInlineStart: 18 }}>{l.apiSteps.map((s) => <li key={s}>{s}</li>)}</ol>
            <label className="field"><span>{l.site}</span>
              <input name="site" required dir="ltr" inputMode="url" placeholder="https://myshop.co.il" defaultValue={site} /></label>
            <LegalChecks docs={legal} locale={locale} label={t.lc.store} />
            <button className="btn btn-primary">{l.apiCta}</button>
            <details className="small muted"><summary>{l.apiWhatTitle}</summary>
              <ul style={{ margin: "6px 0 0", paddingInlineStart: 18 }}>{l.apiWhat.map((s) => <li key={s}>{s}</li>)}</ul></details>
          </form>
        )}

        <details className="card card-flat" style={{ marginTop: 16 }} open={!api}>
          <summary><b>{api ? l.pluginAlt : l.pluginTitle}</b></summary>
          <p className="small muted">{l.pluginWhy}</p>
          <ConnectForm orgId={org.id} l={l} errors={t.errors} defaultSite={site} rotate={connected && c?.method === "plugin"}
            legal={legal} locale={locale} legalLead={t.lc.store} />
          {connected && c?.method === "plugin" && <p className="small muted">{l.rotateNote}</p>}
        </details>
      </div>
    </AppShell>
  );
}
