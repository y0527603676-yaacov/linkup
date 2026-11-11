import Link from "next/link";
import { AppShell, PageHead, Alert } from "@/components/AppShell";
import { CopyButton } from "@/components/CopyButton";
import { LegalChecks, type PendingDoc } from "@/components/LegalChecks";
import { loadApp } from "@/lib/orgs";
import { errorText, money, shortDate } from "@/lib/format";
import { createPlatformConnection, manualReport, manualUpdate } from "../actions";

type Row = { id: string; order_created_at: string; status: string; total_minor: number; refunded_minor: number; currency: string; coupon: string | null; creator: string | null; commission_minor: number };
type Code = { code: string; active: boolean; agreements: { status: string; creator: { name: string } | null; agreement_versions: { version: number; coupon_discount_pct: number }[] } };

/** Manual coupon mode: the store reports orders that used a creator's coupon (plus cancellations and refunds). */
export default async function Sales({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp, "store");
  const { sb, org, t, locale } = ctx;
  const s = t.uc.sales;
  const [{ data: conns }, { data: o }, { data: pend }] = await Promise.all([
    sb.from("store_connections").select("id, site_url").eq("org_id", org.id).eq("method", "manual").eq("status", "connected").limit(1),
    sb.from("organizations").select("website_url").eq("id", org.id).single(),
    sb.rpc("legal_pending", { p_context: "store" }),
  ]);
  const on = !!conns?.length;
  const [{ data: rows }, { data: codes }] = on ? await Promise.all([
    sb.rpc("manual_orders", { p_org: org.id }),
    sb.from("partner_codes").select("code, active, agreements!inner(status, store_org_id, creator:organizations!agreements_creator_org_id_fkey(name), agreement_versions(version, coupon_discount_pct))")
      .eq("agreements.store_org_id", org.id).eq("active", true),
  ]) : [{ data: [] }, { data: [] }];
  const list = (rows ?? []) as Row[];
  const cl = ((codes ?? []) as unknown as Code[]).filter((c) => c.agreements?.status === "active").map((c) => ({
    code: c.code, creator: c.agreements.creator?.name ?? "",
    pct: [...(c.agreements.agreement_versions ?? [])].sort((x, y) => y.version - x.version)[0]?.coupon_discount_pct ?? 0,
  }));
  const today = new Date().toISOString().slice(0, 10);
  return (
    <AppShell ctx={ctx} active="settings" path="/app/sales">
      <div className="narrow">
        <PageHead title={s.title} lead={s.lead}><Link className="btn btn-ghost btn-sm" href={`/app/claims?org=${org.id}`}>{s.claims}</Link></PageHead>
        <Alert text={errorText(sp.error, t)} />
        {sp.ok && s.ok[sp.ok] && <Alert kind="ok" text={s.ok[sp.ok]} />}

        {!on ? (
          <form action={createPlatformConnection} className="card stack">
            <p style={{ margin: 0 }}>{s.start}</p>
            <input type="hidden" name="org" value={org.id} />
            <input type="hidden" name="kind" value="manual" />
            <label className="field"><span>{t.uc.apiPage.site}</span>
              <input name="site" required dir="ltr" inputMode="url" placeholder="myshop.co.il" defaultValue={sp.site ?? o?.website_url ?? ""} /></label>
            <LegalChecks docs={(pend ?? []) as PendingDoc[]} locale={locale} label={t.lc.store} />
            <button className="btn btn-primary">{s.startCta}</button>
          </form>
        ) : (
          <>
            <section className="card stack">
              <h2 style={{ margin: 0 }}>{s.reportTitle}</h2>
              <form action={manualReport} className="stack">
                <input type="hidden" name="org" value={org.id} />
                <label className="field"><span>{s.order}</span><input name="order" required maxLength={64} dir="ltr" /></label>
                <label className="field"><span>{s.date}</span><input name="date" type="date" required max={today} defaultValue={today} /></label>
                <label className="field"><span>{s.total}</span><input name="total" required inputMode="decimal" dir="ltr" placeholder="0.00" /></label>
                <label className="field"><span>{s.shipping}</span><input name="shipping" inputMode="decimal" dir="ltr" placeholder="0" /></label>
                <label className="field"><span>{s.coupon}</span>
                  <select name="coupon" required defaultValue="">
                    <option value="" disabled>—</option>
                    {cl.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.creator}</option>)}
                  </select></label>
                <button className="btn btn-primary" disabled={!cl.length}>{s.submit}</button>
              </form>
              <p className="small muted" style={{ margin: 0 }}>{s.note}</p>
            </section>

            <section className="card stack" style={{ marginTop: 16 }}>
              <h2 style={{ margin: 0 }}>{s.codesTitle}</h2>
              {cl.length ? (
                <>
                  <p className="small muted" style={{ margin: 0 }}>{s.codesHow}</p>
                  {cl.map((c) => (
                    <div key={c.code} className="row between" style={{ gap: 8, flexWrap: "wrap" }}>
                      <span><b className="ltr">{c.code}</b> · {s.discount} {c.pct}% · <span className="muted">{c.creator}</span></span>
                      <CopyButton text={c.code} label={t.common.copy} done={t.common.copied} />
                    </div>
                  ))}
                </>
              ) : <p className="muted" style={{ margin: 0 }}>{s.noCodes}</p>}
            </section>

            <section className="stack" style={{ marginTop: 16 }}>
              <h2 style={{ margin: 0 }}>{s.listTitle}</h2>
              {!list.length && <p className="muted">{s.empty}</p>}
              {list.map((r) => (
                <div key={r.id} className="card card-flat stack" style={{ gap: 6 }}>
                  <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
                    <b className="ltr">#{r.id}</b>
                    <span className="badge">{s.status[r.status] ?? r.status}</span>
                  </div>
                  <p className="small" style={{ margin: 0 }}>{shortDate(r.order_created_at, locale)} · {money(r.total_minor, r.currency, locale)}
                    {r.refunded_minor > 0 && <> · {s.refunded} {money(r.refunded_minor, r.currency, locale)}</>}
                    {r.coupon && <> · <span className="ltr">{r.coupon}</span></>}{r.creator && <> · {r.creator}</>}</p>
                  <p className="small" style={{ margin: 0 }}>{s.commission}: <b>{money(r.commission_minor, r.currency, locale)}</b></p>
                  {r.status !== "cancelled" && (
                    <details className="small"><summary>{s.cancel} / {s.refund}</summary>
                      <div className="stack" style={{ marginTop: 8 }}>
                        <form action={manualUpdate} className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                          <input type="hidden" name="org" value={org.id} /><input type="hidden" name="order" value={r.id} /><input type="hidden" name="action" value="refunded" />
                          <label className="field" style={{ flex: 1, minWidth: 140 }}><span>{s.refundAmount}</span><input name="amount" required inputMode="decimal" dir="ltr" /></label>
                          <button className="btn btn-ghost btn-sm">{s.refundCta}</button>
                        </form>
                        <form action={manualUpdate}>
                          <input type="hidden" name="org" value={org.id} /><input type="hidden" name="order" value={r.id} /><input type="hidden" name="action" value="cancelled" />
                          <button className="btn btn-ghost btn-sm">{s.cancel}</button>
                        </form>
                      </div>
                    </details>
                  )}
                </div>
              ))}
            </section>
          </>
        )}
      </div>
    </AppShell>
  );
}
