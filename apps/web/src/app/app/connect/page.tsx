import { AppShell, PageHead, Alert } from "@/components/AppShell";
import { loadApp } from "@/lib/orgs";
import { errorText, shortDate } from "@/lib/format";
import { ConnectForm } from "./ConnectForm";
import { LegalChecks, type PendingDoc } from "@/components/LegalChecks";
import { shopifyAppOffered } from "@/lib/app-test-shops";
import { startWooApi, syncWooApi, startWpConnect, disconnectStore, detectStoreAction, startAppInstall } from "../actions";

/** Platform apps are offered to stores only after a real end-to-end test (set per platform on the server). */
const APP_ON = { shopify: process.env.LINKUP_SHOPIFY_APP === "1", wix: process.env.LINKUP_WIX_APP === "1" };
import { PLUGIN_LISTED } from "@/lib/wp-connect";
import { detectStore, probeWpAdmin } from "@/lib/store-detect";
import { detectOpts } from "@/lib/detect-env";

export default async function Connect({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp, "store");
  const { sb, org, t, locale } = ctx;
  const l = t.connect;
  const [{ data: conns }, { data: o }, { data: pend }, { data: apiOpen }, { data: wpOpen }, { data: pubDocs }] = await Promise.all([
    sb.from("store_connections").select("status, site_url, last_sync_at, plugin_version, method, last_error, platform").eq("org_id", org.id).order("created_at", { ascending: false }).limit(1),
    sb.from("organizations").select("website_url").eq("id", org.id).single(),
    sb.rpc("legal_pending", { p_context: "store" }),
    sb.rpc("woo_api_available", { p_org: org.id }),
    sb.rpc("wp_connect_available", { p_org: org.id }),
    sb.from("legal_documents").select("doc_key").eq("status", "published").in("doc_key", ["store-terms", "privacy", "cookies"]),
  ]);
  const published = new Set(((pubDocs ?? []) as { doc_key: string }[]).map((d) => d.doc_key));
  const c = conns?.[0] as { status: string; site_url: string; last_sync_at: string | null; plugin_version: string | null; method: string; last_error: string | null; platform?: string } | undefined;
  const legal = (pend ?? []) as PendingDoc[];
  const site = c?.site_url ?? o?.website_url ?? "";
  const api = apiOpen === true;
  const connected = c?.status === "connected";
  const wpAvail = wpOpen === true;
  const w = l.wp;
  const f = l.flow;
  const wpResult = sp.wp === "activation_failed" ? "install_failed" : sp.wp;
  // Detection runs here, on the server, on every view of a result. The address only carries what to check (site, and
  // whether the owner chose "my store is on WooCommerce"); a result can never be injected through the link.
  const checkSite = sp.check === "1" ? (sp.site ?? "").trim() : "";
  const d = checkSite ? await detectStore(checkSite, detectOpts(checkSite)) : null;
  const wantManual = sp.manual === "1";
  // Owner's choice is not proof: the address must really serve WordPress's admin login before we offer the manual path.
  const adminOk = d && d.ok && !d.redirected && d.platform === "unknown" && wantManual
    ? await probeWpAdmin(d.finalUrl || d.url, detectOpts(checkSite)) : null;
  const platform = d && d.ok ? d.platform : "";
  const step = !!d;
  const retry = sp.retry === "1";
  const de = d && !d.ok ? (d.error ?? "unreachable") : undefined;
  const rdFrom = d && d.ok && d.redirected ? d.url : undefined;
  const dsite = (d ? (d.finalUrl || d.url || checkSite) : (sp.site ?? site)).replace(/\/+$/, "");
  const pluginReady = !!d?.linkupPlugin;
  const restBlocked = !!d?.restBlocked;
  const manualOnly = restBlocked;
  // Measurement (host only): what was detected, and why a connection could not continue.
  if (d) {
    const fail = !d.ok ? d.error : rdFrom ? "redirected" : platform === "wordpress" ? "no_woocommerce"
      : ["shopify", "wix", "magento"].includes(platform) ? "unsupported_platform" : wantManual && adminOk === false ? "no_wp_admin" : null;
    await sb.rpc("log_connect_event", { p_org: org.id, p_event: "detected", p_site: d.url || checkSite, p_platform: d.ok ? platform : null });
    if (fail) await sb.rpc("log_connect_event", { p_org: org.id, p_event: "failed", p_site: d.url || checkSite, p_platform: d.ok ? platform : null, p_reason: fail });
  }
  if (sp.error) await sb.rpc("log_connect_event", { p_org: org.id, p_event: "failed", p_site: site || null, p_platform: null, p_reason: String(sp.error).slice(0, 64) });
  const primary: "wp" | "api" | "manual" = manualOnly ? "manual" : wpAvail ? "wp" : api ? "api" : "manual";
  const Prereqs = () => (
    <div className="small" style={{ margin: 0 }}>
      <b>{f.prereqTitle}</b>
      <ul style={{ margin: "4px 0 0", paddingInlineStart: 18 }}>{f.prereqs.map((x) => <li key={x}>{x}</li>)}</ul>
    </div>
  );
  const u = t.uc;
  /** The other automatic way to connect (custom sites); if neither fits, the site cannot be tracked yet. */
  const helpHref = `/app/connect/help?${new URLSearchParams({ org: org.id, site: dsite, p: platform || "" })}`;
  const guideHref = `/app/connect/guide?${new URLSearchParams({ org: org.id, site: dsite })}`;
  const Alternatives = () => (
    <div className="stack" style={{ gap: 10, marginTop: 4 }}>
      <div className="card card-flat stack" style={{ gap: 6 }}>
        <b>{u.api.t}</b><p className="small muted" style={{ margin: 0 }}>{u.api.d}</p>
        <a className="btn btn-primary btn-sm" href={helpHref}>{u.help.cta}</a>
        <a className="btn btn-ghost btn-sm" href={`/app/connect/api?${new URLSearchParams({ org: org.id, site: dsite })}`}>{u.api.cta}</a>
      </div>
      <p className="small muted" style={{ margin: 0 }}>{u.noAuto}</p>
    </div>
  );
  const names: Record<string, string> = { shopify: "Shopify", wix: "Wix", magento: "Magento" };
  const Retry = ({ ghost, again, label }: { ghost?: boolean; again?: boolean; label?: string }) => (
    <div className="row" style={{ gap: 8 }}>
      {again && <form action={detectStoreAction}><input type="hidden" name="org" value={org.id} /><input type="hidden" name="site" value={rdFrom ?? dsite} />
        <button className={`btn ${ghost ? "btn-ghost" : "btn-primary"} btn-sm`}>{f.recheck}</button></form>}
      <a className={`btn btn-ghost btn-sm`} href={`/app/connect?${new URLSearchParams({ org: org.id, retry: "1", site: rdFrom ?? dsite })}`}>{label ?? f.otherSite}</a>
    </div>
  );
  return (
    <AppShell ctx={ctx} active="settings" path="/app/connect">
      <div className="narrow">
        <PageHead title={l.title} lead={l.leadApi} />
        <Alert text={errorText(sp.error, t)} />
        {sp.ok === "sync" && <Alert kind="ok" text={l.syncStarted} />}
        {sp.ok === "disconnected" && <Alert kind="ok" text={l.disconnect.ok} />}
        {sp.ok === "app_connected" && <Alert kind="ok" text={u.app.connected} />}
        {wpResult === "connected" && <Alert kind="ok" text={w.done} />}
        {wpResult && wpResult !== "connected" && <Alert text={wpResult === "not_in_directory" ? `${w.errors.not_in_directory} ${w.uploadThen}` : (w.errors[wpResult] ?? w.errors.other)} />}
        {sp.wpr === "0" && <Alert text={w.notRevoked} />}

        {c && (
          <div className="card card-flat stack" style={{ marginBottom: 16, gap: 6 }}>
            <p className="row" style={{ margin: 0 }}><span className={`dot${connected && !c.last_error ? "" : " dot-off"}`} /><b>{t.dash.connection[c.status]}</b> · <span className="ltr">{c.site_url}</span></p>
            <p className="small muted" style={{ margin: 0 }}>{c.method === "api" ? l.viaApi : c.method === "signed_api" ? u.viaCustom : l.viaPlugin}
              {c.last_sync_at ? ` · ${t.dash.connection.lastSync}: ${shortDate(c.last_sync_at, locale)}` : ""}
              {c.method === "plugin" && c.plugin_version ? ` · v${c.plugin_version}` : ""}</p>
            {c.method === "signed_api" && <a className="btn btn-ghost btn-sm" href={`/app/connect/api?org=${org.id}`}>{u.toApi}</a>}
            {c.status === "connected" && <a className="small" href={`/app/claims?org=${org.id}`}>{u.claims.title}</a>}
            {c.last_error && <p className="alert alert-warn small" style={{ margin: 0 }}>{l.errors[c.last_error] ?? l.errors.other}</p>}
            {c.method === "api" && c.status !== "disconnected" && (
              <form action={syncWooApi}><input type="hidden" name="org" value={org.id} /><button className="btn btn-ghost btn-sm">{l.syncNow}</button></form>
            )}
          </div>
        )}

        {/* Step 1 – the store's address (always available; collapsed when already connected) */}
        {(!step || retry) && (
          <details className="card stack connect-step" open={!connected || retry} style={{ marginTop: 8 }}>
            <summary className={connected && !retry ? "" : "sr-only"}><b>{f.askTitle}</b></summary>
            <ol className="stepper" aria-label={f.askTitle}>{f.steps.map((x, i) => <li key={x} className={i === 0 ? "on" : ""}><span>{i + 1}</span>{x}</li>)}</ol>
            <h2 style={{ margin: 0 }}>{f.askTitle}</h2>
            <p className="small muted" style={{ margin: 0 }}>{f.askHint}</p>
            <form action={detectStoreAction} className="stack" data-own-pending="">
              <input type="hidden" name="org" value={org.id} />
              <input name="site" required dir="ltr" inputMode="url" autoComplete="url" placeholder="myshop.co.il" defaultValue={sp.site ?? site} aria-label={l.site} />
              <button className="btn btn-primary btn-block">{f.check}</button>
            </form>
            <p className="small muted" style={{ margin: 0 }}>{f.supportedNow}</p>
          </details>
        )}

        {/* Step 2/3 – what we found, and the one matching way to connect */}
        {step && !retry && (
          <section className="card stack connect-step" style={{ marginTop: 8 }}>
            <ol className="stepper">{f.steps.map((x, i) => <li key={x} className={i <= ((platform === "woocommerce" && !rdFrom) || (wantManual && adminOk) ? 2 : 1) ? "on" : ""}><span>{i + 1}</span>{x}</li>)}</ol>

            {de ? (
              <>
                <p className="alert alert-warn" style={{ margin: 0 }}>{f.errors[de] ?? f.errors.unreachable}</p>
                <Retry again={de === "timeout" || de === "unreachable" || de === "http_error"} />
              </>
            ) : rdFrom ? (
              <>
                <h2 style={{ margin: 0 }}>{f.redirectTitle}</h2>
                <p style={{ margin: 0 }}>{f.redirectText.replace("{to}", dsite.replace(/^https:\/\//, ""))}</p>
                <form action={detectStoreAction}><input type="hidden" name="org" value={org.id} /><input type="hidden" name="site" value={dsite} />
                  <button className="btn btn-primary btn-block">{f.continueWith}</button></form>
                <Retry ghost />
              </>
            ) : platform === "woocommerce" ? (
              <>
                <p className="found"><span className="dot" /> <b>{f.found}</b> · <span className="ltr">{dsite.replace(/^https:\/\//, "")}</span></p>
                {pluginReady && <p className="small" style={{ margin: 0 }}>{f.pluginReady}</p>}
                {restBlocked && <p className="alert alert-warn small" style={{ margin: 0 }}>{f.restBlocked}</p>}
                {primary === "wp" && (
                  <form action={startWpConnect} className="card stack" style={{ marginTop: 16 }}>
            <input type="hidden" name="org" value={org.id} />
            <div className="row between" style={{ alignItems: "baseline" }}><h3 style={{ margin: 0 }}>{w.title}</h3><span className="badge badge-brand">{w.badge}</span></div>
            <p className="small" style={{ margin: 0 }}>{PLUGIN_LISTED || pluginReady ? w.lead : w.leadManual}</p>
            <ol className="small muted" style={{ margin: 0, paddingInlineStart: 18 }}>{(PLUGIN_LISTED || pluginReady ? w.steps : w.stepsManual).map((x) => <li key={x}>{x}</li>)}</ol>
            {!PLUGIN_LISTED && !pluginReady && (
              <div className="stack small" style={{ gap: 6 }}>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <a className="btn btn-ghost btn-sm" href="/downloads/linkup-connector.zip" download>{w.download}</a>
                  <a className="btn btn-ghost btn-sm" href={`${dsite}/wp-admin/plugin-install.php?tab=upload`} target="_blank" rel="noopener">{w.openUpload}</a>
                </div>
                <p className="muted" style={{ margin: 0 }}>{w.uploadHow}</p>
              </div>
            )}
            <input type="hidden" name="site" value={dsite} />
            <p className="small" style={{ margin: 0 }}><span className="muted">{l.site}:</span> <b className="ltr">{dsite}</b></p>
            <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 8 }}>
              <legend><b>{w.consentTitle}</b></legend>
              <p className="small" style={{ margin: 0 }}>{w.consentLead}</p>
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
            {published.size > 0
              ? <p className="small" style={{ margin: 0 }}>{w.docsNote} {([["store-terms", w.docTerms], ["privacy", w.docPrivacy], ["cookies", w.docCookies]] as const)
                  .filter(([k]) => published.has(k)).map(([k, label], i) => <span key={k}>{i > 0 ? " · " : ""}<a href={`/legal/${k}`} target="_blank">{label}</a></span>)}</p>
              : <p className="small muted" style={{ margin: 0 }}>{w.docsPending}</p>}
            <LegalChecks docs={legal} locale={locale} label={t.lc.store} />
            <button className="btn btn-primary">{w.cta}</button>
            <p className="small muted" style={{ margin: 0 }}>{w.needAdmin} {w.recorded}</p>
          </form>
                )}
                {primary === "api" && (
          <form action={startWooApi} className="card stack" style={{ marginTop: 16 }}>
            <input type="hidden" name="org" value={org.id} />
            <div className="row between" style={{ alignItems: "baseline" }}><h3 style={{ margin: 0 }}>{l.apiTitle}</h3><span className="badge badge-brand">{l.recommended}</span></div>
            <ol className="small" style={{ margin: 0, paddingInlineStart: 18 }}>{l.apiSteps.map((s) => <li key={s}>{s}</li>)}</ol>
            <input type="hidden" name="site" value={dsite} />
            <p className="small" style={{ margin: 0 }}><span className="muted">{l.site}:</span> <b className="ltr">{dsite}</b></p>
            <LegalChecks docs={legal} locale={locale} label={t.lc.store} />
            <button className="btn btn-primary">{l.apiCta}</button>
            <details className="small muted"><summary>{l.apiWhatTitle}</summary>
              <ul style={{ margin: "6px 0 0", paddingInlineStart: 18 }}>{l.apiWhat.map((s) => <li key={s}>{s}</li>)}</ul></details>
          </form>
                )}
                {primary === "manual" && (
                  <div className="stack">
                    <h3 style={{ margin: 0 }}>{f.manualTitle}</h3>
                    <p className="small muted" style={{ margin: 0 }}>{f.manualLead}</p>
                    <Prereqs />
                    <ConnectForm orgId={org.id} l={l} errors={t.errors} defaultSite={dsite} rotate={connected && c?.method === "plugin"}
                      legal={legal} locale={locale} legalLead={t.lc.store} />
                  </div>
                )}
                {primary !== "manual" && (
                  <details className="small">
                    <summary>{f.otherWay}</summary>
                    <div className="stack" style={{ marginTop: 8 }}>
                      <p className="small muted" style={{ margin: 0 }}>{f.manualLead}</p>
                      <Prereqs />
                      <ConnectForm orgId={org.id} l={l} errors={t.errors} defaultSite={dsite} rotate={connected && c?.method === "plugin"}
                        legal={legal} locale={locale} legalLead={t.lc.store} />
                    </div>
                  </details>
                )}
                <Retry ghost label={f.otherSite} />
              </>
            ) : platform === "wordpress" ? (
              <>
                <h2 style={{ margin: 0 }}>{f.wpNoWoo.t}</h2>
                <p style={{ margin: 0 }}>{f.wpNoWoo.d}</p>
                <Retry again />
                <Alternatives />
              </>
            ) : (platform === "shopify" && (APP_ON.shopify || shopifyAppOffered(d?.shopifyDomain))) || (platform === "wix" && APP_ON.wix) ? (
              <>
                <p className="found" style={{ margin: 0 }}><span className="dot" /> <b>{u.app.found.replace("{p}", names[platform] ?? platform)}</b> · <span className="ltr">{dsite.replace(/^https?:\/\//, "")}</span></p>
                <p style={{ margin: 0 }}>{u.app.lead.replace("{p}", names[platform] ?? platform)}</p>
                <form action={startAppInstall} className="stack">
                  <input type="hidden" name="org" value={org.id} />
                  <input type="hidden" name="platform" value={platform} />
                  <input type="hidden" name="site" value={dsite} />
                  {platform === "shopify" && (d?.shopifyDomain
                    ? <input type="hidden" name="shop" value={d.shopifyDomain} />
                    : <label className="field"><span>{u.app.shopField}</span><input name="shop" required dir="ltr" placeholder="mystore.myshopify.com" />
                        <small className="muted">{u.app.shopHint}</small></label>)}
                  <LegalChecks docs={legal} locale={locale} label={t.lc.store} />
                  <button className="btn btn-primary btn-block">{u.app.cta.replace("{p}", names[platform] ?? platform)}</button>
                </form>
                <Retry ghost label={f.otherSite} />
              </>
            ) : platform === "shopify" || platform === "wix" || platform === "magento" ? (
              <>
                <h2 style={{ margin: 0 }}>{f.unsupported.t.replace("{p}", names[platform] ?? platform)}</h2>
                <p style={{ margin: 0 }}>{u.platformSoon.replace("{p}", names[platform] ?? platform)} <a href="/contact">{l.tellUs}</a></p>
                
                <Retry ghost label={f.otherSite} />
              </>
            ) : wantManual && adminOk ? (
              <>
                <p className="alert alert-warn" style={{ margin: 0 }}><b>{f.manualChoice.t}</b> · <span className="ltr">{dsite.replace(/^https?:\/\//, "")}</span><br />{f.manualChoice.verified}</p>
                <div className="stack">
                  <h3 style={{ margin: 0 }}>{f.manualTitle}</h3>
                  <Prereqs />
                  <ConnectForm orgId={org.id} l={l} errors={t.errors} defaultSite={dsite} rotate={false}
                    legal={legal} locale={locale} legalLead={t.lc.store} />
                </div>
                <Retry ghost label={f.otherSite} />
              </>
            ) : wantManual ? (
              <>
                <h2 style={{ margin: 0 }}>{f.manualChoice.noAdminT}</h2>
                <p style={{ margin: 0 }}>{f.manualChoice.notVerified}</p>
                <Alternatives />
                <Retry ghost again />
              </>
            ) : (
              <>
                <h2 style={{ margin: 0 }}>{f.unknown.t}</h2>
                <p style={{ margin: 0 }}>{f.unknown.d}</p>
                <a className="btn btn-primary btn-block" href={`/app/connect?${new URLSearchParams({ org: org.id, site: dsite, check: "1", manual: "1" })}`}>{f.unknown.wooYes}</a>
                <details className="small"><summary>{f.unknown.other}</summary><Alternatives /></details>
                <Retry ghost again />
              </>
            )}
          </section>
        )}
          {!(c && c.status === "connected") && (
            <p className="small" style={{ marginTop: 12 }}>{u.help.need}{" "}
              {(!platform || platform === "woocommerce") && <><a href={guideHref}>{u.help.guideCta}</a>{" · "}</>}
              <a href={helpHref}>{u.help.cta}</a></p>
          )}

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
