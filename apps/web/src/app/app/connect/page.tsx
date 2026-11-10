import { AppShell, PageHead, Alert } from "@/components/AppShell";
import { loadApp } from "@/lib/orgs";
import { errorText, shortDate } from "@/lib/format";
import { ConnectForm } from "./ConnectForm";
import { LegalChecks, type PendingDoc } from "@/components/LegalChecks";
import { startWooApi, syncWooApi, startWpConnect, disconnectStore } from "../actions";

export default async function Connect({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp, "store");
  const { sb, org, t, locale } = ctx;
  const l = t.connect;
  const [{ data: conns }, { data: o }, { data: pend }, { data: apiOpen }, { data: wpOpen }] = await Promise.all([
    sb.from("store_connections").select("status, site_url, last_sync_at, plugin_version, method, last_error").eq("org_id", org.id).order("created_at", { ascending: false }).limit(1),
    sb.from("organizations").select("website_url").eq("id", org.id).single(),
    sb.rpc("legal_pending", { p_context: "store" }),
    sb.rpc("woo_api_available", { p_org: org.id }),
    sb.rpc("wp_connect_available", { p_org: org.id }),
  ]);
  const c = conns?.[0] as { status: string; site_url: string; last_sync_at: string | null; plugin_version: string | null; method: string; last_error: string | null } | undefined;
  const legal = (pend ?? []) as PendingDoc[];
  const site = c?.site_url ?? o?.website_url ?? "";
  const api = apiOpen === true;
  const connected = c?.status === "connected";
  const wpAvail = wpOpen === true;
  const w = l.wp;
  const wpResult = sp.wp;
  return (
    <AppShell ctx={ctx} active="settings" path="/app/connect">
      <div className="narrow">
        <PageHead title={l.title} lead={api ? l.leadApi : l.lead} />
        <Alert text={errorText(sp.error, t)} />
        {sp.ok === "sync" && <Alert kind="ok" text={l.syncStarted} />}
        {sp.ok === "disconnected" && <Alert kind="ok" text={l.disconnect.ok} />}
        {wpResult === "connected" && <Alert kind="ok" text={w.done} />}
        {wpResult && wpResult !== "connected" && <Alert text={w.errors[wpResult] ?? w.errors.other} />}
        {sp.wpr === "0" && <Alert text={w.notRevoked} />}

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

        {wpAvail && !(c?.method === "plugin" && connected) && (
          <form action={startWpConnect} className="card stack" style={{ marginTop: 16 }}>
            <input type="hidden" name="org" value={org.id} />
            <div className="row between" style={{ alignItems: "baseline" }}><h3 style={{ margin: 0 }}>{w.title}</h3><span className="badge badge-brand">{w.badge}</span></div>
            <p className="small" style={{ margin: 0 }}>{w.lead}</p>
            <ol className="small muted" style={{ margin: 0, paddingInlineStart: 18 }}>{w.steps.map((x) => <li key={x}>{x}</li>)}</ol>
            <label className="field"><span>{l.site}</span>
              <input name="site" required dir="ltr" inputMode="url" placeholder="https://myshop.co.il" defaultValue={site} /></label>
            <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 8 }}>
              <legend className="small"><b>{w.consentTitle}</b></legend>
              {Object.keys(w.items).map((k) => (
                <div key={k} className="stack" style={{ gap: 2 }}>
                  <label className="row small" style={{ alignItems: "flex-start", gap: 8, flexWrap: "nowrap" }}><input style={{ width: "auto", marginTop: 2, flex: "none" }} type="checkbox" name="consent" value={k} required /> <span>{w.items[k]}</span></label>
                  <details className="small muted" style={{ paddingInlineStart: 26 }}><summary>{w.details}</summary>
                    <ul style={{ margin: "4px 0 0", paddingInlineStart: 18 }}>{(w.itemDetails[k] ?? []).map((d) => <li key={d}>{d}</li>)}</ul></details>
                </div>
              ))}
            </fieldset>
            <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 4 }}>
              <legend className="small"><b>{w.modeTitle}</b></legend>
              <label className="row small" style={{ alignItems: "flex-start", gap: 8, flexWrap: "nowrap" }}><input style={{ width: "auto", marginTop: 2, flex: "none" }} type="radio" name="mode" value="notice" defaultChecked /> <span>{w.modeNotice}</span></label>
              <label className="row small" style={{ alignItems: "flex-start", gap: 8, flexWrap: "nowrap" }}><input style={{ width: "auto", marginTop: 2, flex: "none" }} type="radio" name="mode" value="require" /> <span>{w.modeRequire}</span></label>
              <p className="small muted" style={{ margin: 0 }}>{w.modeHint}</p>
            </fieldset>
            <p className="small" style={{ margin: 0 }}>{w.docsLead} <a href="/legal/store-terms" target="_blank">{w.docTerms}</a> · <a href="/legal/privacy" target="_blank">{w.docPrivacy}</a> · <a href="/legal/cookies" target="_blank">{w.docCookies}</a></p>
            <LegalChecks docs={legal} locale={locale} label={t.lc.store} />
            <button className="btn btn-primary">{w.cta}</button>
            <p className="small muted" style={{ margin: 0 }}>{w.needAdmin} {w.recorded}</p>
          </form>
        )}

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

        <details className="card card-flat" style={{ marginTop: 16 }} open={!api && !wpAvail}>
          <summary><b>{api || wpAvail ? l.pluginAlt : l.pluginTitle}</b></summary>
          <p className="small muted">{l.pluginWhy}</p>
          <ConnectForm orgId={org.id} l={l} errors={t.errors} defaultSite={site} rotate={connected && c?.method === "plugin"}
            legal={legal} locale={locale} legalLead={t.lc.store} />
          {connected && c?.method === "plugin" && <p className="small muted">{l.rotateNote}</p>}
        </details>

        {c && c.status !== "disconnected" && (
          <details className="card card-flat" style={{ marginTop: 16 }}>
            <summary className="small"><b>{l.disconnect.title}</b></summary>
            <ul className="small muted" style={{ margin: "6px 0", paddingInlineStart: 18 }}>{l.disconnect.text.map((x) => <li key={x}>{x}</li>)}</ul>
            <form action={disconnectStore}><input type="hidden" name="org" value={org.id} />
              <button className="btn btn-ghost btn-sm">{l.disconnect.cta}</button></form>
          </details>
        )}
      </div>
    </AppShell>
  );
}
