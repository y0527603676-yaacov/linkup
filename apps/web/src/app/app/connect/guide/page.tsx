import Link from "next/link";
import { AppShell, PageHead } from "@/components/AppShell";
import { loadApp } from "@/lib/orgs";
import { detectStore } from "@/lib/store-detect";
import { detectOpts } from "@/lib/detect-env";

/** Step-by-step visual guide for the WooCommerce connection: one instruction per screen. */
export default async function ConnectGuide({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp, "store");
  const { sb, org, t } = ctx;
  const g = t.uc.guide;
  const site = (sp.site ?? "").trim();
  // The link into the store's WordPress is shown only when the address really is a WooCommerce store.
  const d = site ? await detectStore(site, detectOpts(site)) : null;
  const woo = !!d && d.ok && d.platform === "woocommerce" && !d.redirected;
  const base = woo ? (d!.finalUrl || d!.url).replace(/\/+$/, "") : "";
  const n = Math.min(Math.max(Number(sp.step) || 1, 1), g.steps.length);
  const s = g.steps[n - 1]!;
  if (n === 1) await sb.rpc("log_connect_event", { p_org: org.id, p_event: "guide_opened", p_site: site || null, p_platform: d?.ok ? d.platform : null });
  const q = (k: number) => `/app/connect/guide?${new URLSearchParams({ org: org.id, site, step: String(k) })}`;
  return (
    <AppShell ctx={ctx} active="settings" path="/app/connect/guide">
      <div className="narrow">
        <PageHead title={g.title} lead={g.lead} />
        <ol className="stepper" aria-label={g.title}>
          {g.steps.map((x, i) => <li key={x.t} className={i < n ? "on" : ""} aria-current={i === n - 1 ? "step" : undefined}><span className="num">{i + 1}</span></li>)}
        </ol>
        <section className="card stack">
          <p className="small muted" style={{ margin: 0 }}>{g.stepOf.replace("{n}", String(n)).replace("{total}", String(g.steps.length))}</p>
          <h2 style={{ margin: 0 }}>{s.t}</h2>
          <p style={{ margin: 0 }}>{s.d}</p>
          {s.img && <img src={s.img} alt={s.alt ?? ""} loading="lazy" style={{ width: "100%", height: "auto", borderRadius: 12, border: "1px solid var(--line)" }} />}
          {n === 1 && <a className="btn btn-primary" href="/downloads/linkup-connector.zip" download>{g.download}</a>}
          {n === 2 && (woo
            ? <a className="btn btn-primary" href={`${base}/wp-admin/plugin-install.php?tab=upload`} target="_blank" rel="noopener">{g.openUpload}</a>
            : <p className="small muted" style={{ margin: 0 }}>{g.noLink}</p>)}
          {n === g.steps.length && <Link className="btn btn-primary" href={`/app/connect?${new URLSearchParams({ org: org.id, ...(site ? { site, check: "1" } : {}) })}`}>{g.checkNow}</Link>}
          <div className="row" style={{ gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}>
            {n > 1 ? <Link className="btn btn-ghost btn-sm" href={q(n - 1)}>{g.prev}</Link> : <span />}
            {n < g.steps.length && <Link className="btn btn-ghost btn-sm" href={q(n + 1)}>{g.next}</Link>}
          </div>
        </section>
        <p className="small" style={{ marginTop: 16 }}>{g.stuck} <Link href={`/app/connect/help?${new URLSearchParams({ org: org.id, site, p: d?.ok ? d.platform : "" })}`}>{t.uc.help.cta}</Link></p>
      </div>
    </AppShell>
  );
}
