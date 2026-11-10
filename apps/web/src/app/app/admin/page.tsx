import { redirect } from "next/navigation";
import { AppShell, PageHead, Alert, Stat } from "@/components/AppShell";
import { loadApp } from "@/lib/orgs";
import { errorText, money, shortDate } from "@/lib/format";
import { adminAction } from "../actions";

export default async function Admin({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp);
  const { sb, org, isPlatformAdmin, t, locale } = ctx;
  if (!isPlatformAdmin) redirect(`/app?org=${org.id}`);
  const a = t.admin;
  const [{ data }, { data: ai }] = await Promise.all([sb.rpc("admin_overview"), sb.rpc("admin_invoices")]);
  const d = data as Record<string, any>;
  const A = (ai ?? { invoices: [], tax_profiles: [], tax_approved: false }) as Record<string, any>;
  const pct = (bps: number) => `${(Number(bps) / 100).toLocaleString("en", { maximumFractionDigits: 2 })}%`;
  const previewFor = sp.preview && /^\d{4}-\d{2}-01$/.test(sp.preview) ? sp.preview : null;
  const { data: pv } = previewFor ? await sb.rpc("preview_invoices", { p_period_start: previewFor }) : { data: null };
  const docTypes = Object.entries(a.docTypes);
  const stores = (d.recent_orgs ?? []).filter((o: any) => o.type === "store");
  const prev = new Date(); prev.setUTCDate(1); prev.setUTCMonth(prev.getUTCMonth() - 1);
  const period = prev.toISOString().slice(0, 10);
  const H = ({ children }: { children: string }) => <div className="section-head"><h2>{children}</h2></div>;
  const hidden = <input type="hidden" name="org" value={org.id} />;
  const funnelOrder = ["signup", "activity_added", "store_connected", "products_synced", "opportunity_published", "invite_sent", "invite_opened",
    "proposal_accepted", "opportunity_joined", "first_attributed_sale", "campaign_launched", "creative_shared", "referral_link_shared", "referral_signup", "invoice_paid", "reward_earned"];
  return (
    <AppShell ctx={ctx} active="admin" path="/app/admin">
      <PageHead title={a.title} />
      <Alert text={errorText(sp.error, t)} />
      {sp.ok && <Alert kind="ok" text={t.common.saved} />}
      <section className="stats">
        <Stat label={a.stores} value={d.stores} /><Stat label={a.creators} value={d.creators} /><Stat label={a.connected} value={d.connected_stores} />
        <Stat label={a.sales30} value={d.attributed_sales_30d} /><Stat label={a.feesPending} value={money(d.platform_fees_pending_minor, "ILS", locale)} />
        <Stat label={a.uninvoiced} value={money(d.platform_fees_uninvoiced_minor, "ILS", locale)} /><Stat label={a.openInv} value={money(d.invoices_open_minor, "ILS", locale)} />
        <Stat money label={a.paidInv} value={money(d.invoices_paid_minor, "ILS", locale)} /><Stat label={a.rewards} value={money(d.rewards_earned_minor, "ILS", locale)} />
        <Stat label={a.suspected} value={d.suspected_self_referrals} /><Stat label={a.blocked} value={d.blocked_referrals} />
      </section>

      <section className="section"><H>{a.funnel}</H>
        <div className="table-wrap card card-flat"><table className="t"><thead><tr><th /><th>30d</th><th>Σ</th></tr></thead><tbody>
          {funnelOrder.map((k) => <tr key={k}><td>{a.events[k]}</td><td>{d.funnel?.[k]?.last_30d ?? 0}</td><td>{d.funnel?.[k]?.total ?? 0}</td></tr>)}
        </tbody></table></div>
      </section>

      {(d.silent_connections ?? []).length > 0 && (
        <section className="section"><H>{a.silent}</H>
          <div className="list">{d.silent_connections.map((c: any, i: number) => <div className="item" key={i}><span className="title">{c.org}</span><span className="meta ltr">{c.site_url} · {shortDate(c.last_sync_at, locale)}</span></div>)}</div>
        </section>
      )}

      <section className="section"><H>{a.invoices}</H>
        {!A.tax_approved && <Alert kind="warn" text={a.gated} />}
        <div className="row" style={{ marginBottom: 12, gap: 8, flexWrap: "wrap" }}>
          <form className="row" method="get">{hidden}
            <input type="date" name="preview" defaultValue={previewFor ?? period} style={{ width: "auto" }} /><button className="btn btn-ghost btn-sm">{a.preview}</button></form>
          {A.tax_approved && <form action={adminAction} className="row">{hidden}<input type="hidden" name="op" value="generate" />
            <input type="date" name="period" defaultValue={period} style={{ width: "auto" }} /><button className="btn btn-primary btn-sm">{a.generate}</button></form>}
        </div>
        {previewFor && (
          <div className="table-wrap card card-flat" style={{ marginBottom: 12 }}>
            <p className="small muted">{a.previewTitle} · {previewFor}</p>
            <table className="t small"><thead><tr><th>{a.store}</th><th>{t.money.fees}</th><th>{t.money.vat("")}</th><th>{t.money.rewardOffset}</th><th>{t.money.rewardVat("")}</th><th>{t.money.total}</th></tr></thead><tbody>
              {((pv ?? []) as any[]).map((x, k) => (
                <tr key={k}><td>{x.store}{x.offset_blocked && <div className="small muted">{a.offsetBlocked}</div>}</td>
                  <td className="ltr">{money(x.fees_minor, x.currency, locale)}</td><td className="ltr">{money(x.vat_minor, x.currency, locale)} ({pct(x.vat_bps)})</td>
                  <td className="ltr">−{money(x.reward_offset_minor, x.currency, locale)}</td><td className="ltr">−{money(x.reward_vat_minor, x.currency, locale)}</td>
                  <td className="ltr"><b>{money(x.total_minor, x.currency, locale)}</b></td></tr>))}
            </tbody></table>
          </div>
        )}
        <div className="stack">
          {(A.invoices ?? []).map((i: any) => (
            <div className="card card-flat" key={i.id}>
              <div className="row between"><b>#{i.number} · {i.store} · {i.period_start}</b>
                <span className="row">{i.overdue && <span className="badge badge-warn">{t.money.overdue}</span>}<span className="badge">{t.money.status[i.status]}</span></span></div>
              <div className="meta small ltr" style={{ marginTop: 4 }}>
                {money(i.fees_minor, i.currency, locale)} + {pct(i.vat_bps)} {money(i.vat_minor, i.currency, locale)}
                {Number(i.credit_minor) > 0 ? ` − (${money(i.reward_offset_minor, i.currency, locale)} + ${pct(i.reward_vat_bps)} ${money(i.reward_vat_minor, i.currency, locale)})` : ""}
                {" = "}<b>{money(i.total_minor, i.currency, locale)}</b>{i.store_classification ? ` · ${t.taxp.classes[i.store_classification]}` : ""}
              </div>
              <div className="small muted">{i.delivered_at ? `${a.deliveredAt}: ${shortDate(i.delivered_at, locale)} (${i.delivery_method}) · ${a.dueAt}: ${shortDate(i.due_at, locale)}` : a.awaiting}{i.paid_reference ? ` · ${i.paid_reference}` : ""}</div>
              {(i.documents ?? []).length > 0 && <div className="small">{(i.documents as any[]).map((x, k) => <div key={k}>{a.issuers[x.issuer]} · {a.docTypes[x.type]} {x.number} · {x.date}</div>)}</div>}
              <div className="row small">{i.missing_linkup_doc && <span className="badge badge-warn">{a.missingLinkup}</span>}{i.missing_counterparty_doc && <span className="badge badge-warn">{a.missingCounter}</span>}</div>
              {i.status === "issued" && !i.delivered_at && (
                <form action={adminAction} className="row" style={{ marginTop: 8 }}>{hidden}<input type="hidden" name="id" value={i.id} /><input type="hidden" name="op" value="delivered" />
                  <select name="method" aria-label={a.methodLabel} style={{ width: "auto" }}>{["email", "whatsapp", "in_app", "other"].map((k) => <option key={k} value={k}>{k}</option>)}</select>
                  <input type="datetime-local" name="at" style={{ width: "auto" }} /><input name="reference" placeholder={t.money.reference} style={{ width: 140 }} />
                  <button className="btn btn-ghost btn-sm">{a.markDelivered}</button></form>)}
              {i.status === "issued" && (
                <form action={adminAction} className="row" style={{ marginTop: 8 }}>{hidden}<input type="hidden" name="id" value={i.id} />
                  <input name="reference" placeholder={t.money.reference} style={{ width: 130 }} />
                  <button className="btn btn-primary btn-sm" name="op" value="paid">{a.markPaid}</button>
                  {!i.delivered_at && <button className="btn btn-danger btn-sm" name="op" value="void">{a.void}</button>}</form>)}
              {i.status !== "void" && (
                <details style={{ marginTop: 8 }}><summary className="small">{a.recordDoc}</summary>
                  <form action={adminAction} className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>{hidden}<input type="hidden" name="op" value="doc" /><input type="hidden" name="invoice" value={i.id} />
                    <select name="issuer" style={{ width: "auto" }}>{Object.entries(a.issuers).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                    <select name="doc_type" style={{ width: "auto" }}>{docTypes.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                    <input name="number" required placeholder={a.docNumber} style={{ width: 110 }} /><input type="date" name="date" required style={{ width: "auto" }} />
                    <input name="amount" inputMode="decimal" required placeholder={a.amount} style={{ width: 110 }} /><input name="vat" inputMode="decimal" placeholder={a.vat} style={{ width: 90 }} />
                    <button className="btn btn-ghost btn-sm">{t.common.save}</button></form></details>)}
            </div>
          ))}
        </div>
      </section>

      <section className="section"><H>{a.taxProfiles}</H>
        <div className="list">{(A.tax_profiles ?? []).map((p: any) => (
          <form action={adminAction} className="item" key={p.org_id}>{hidden}<input type="hidden" name="op" value="verify" /><input type="hidden" name="target" value={p.org_id} />
            <div className="grow"><div className="title">{p.org} · {p.legal_name}</div>
              <div className="meta">{t.taxp.classes[p.classification]} · {p.tax_id ?? "—"} · {p.country}{p.foreign_evidence ? ` · ${p.foreign_evidence}` : ""}{p.foreign_no_il_presence ? " · no IL presence" : ""}</div>
              <div className="meta">{p.verified_at ? `${t.taxp.verified} ${shortDate(p.verified_at, locale)}${p.zero_rate_approved ? " · VAT 0%" : ""}` : t.taxp.pending}</div></div>
            {p.classification === "foreign_resident" && <label className="row small"><input type="checkbox" name="zero" value="1" defaultChecked={p.zero_rate_approved} /> {a.zeroRate}</label>}
            <button className="btn btn-ghost btn-sm">{a.verify}</button></form>))}</div>
      </section>

      <section className="section"><H>{a.pricing}</H>
        <form action={adminAction} className="card card-flat row" style={{ flexWrap: "wrap", marginBottom: 8 }}>{hidden}<input type="hidden" name="op" value="rate" />
          <span className="small" style={{ width: "100%" }}>{a.rateChange}</span>
          <input name="pct" inputMode="decimal" required placeholder={a.pct} style={{ width: 80 }} /><input type="date" name="from" required style={{ width: "auto" }} />
          <input name="note" placeholder={a.note} style={{ flex: 1, minWidth: 120 }} /><button className="btn btn-ghost btn-sm">{t.common.save}</button></form>
        <form action={adminAction} className="card card-flat row" style={{ flexWrap: "wrap" }}>{hidden}<input type="hidden" name="op" value="individual" />
          <span className="small" style={{ width: "100%" }}>{a.individual}</span>
          <select name="store" required style={{ width: "auto" }}>{stores.map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          <input name="pct" inputMode="decimal" required placeholder={a.pct} style={{ width: 80 }} /><input type="date" name="from" required style={{ width: "auto" }} aria-label={a.from} />
          <input type="date" name="until" style={{ width: "auto" }} aria-label={a.until} /><input name="note" required placeholder={a.note} style={{ flex: 1, minWidth: 120 }} />
          <button className="btn btn-ghost btn-sm">{t.common.save}</button></form>
      </section>

      {(d.rewards_owed ?? []).length > 0 && (
        <section className="section"><H>{a.owed}</H>
          <div className="list">{d.rewards_owed.map((r: any) => (
            <div className="item" key={r.org_id}><span className="title">{r.name}</span><span className="amount">{money(r.balance_minor, "ILS", locale)}</span>
              <form action={adminAction} className="row" style={{ flexWrap: "wrap" }}>{hidden}<input type="hidden" name="target" value={r.org_id} />
                <span className="small muted" style={{ width: "100%" }}>{a.transferDoc}</span>
                <select name="doc_type" style={{ width: "auto" }}>{docTypes.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                <input name="doc_number" required placeholder={a.docNumber} style={{ width: 100 }} /><input type="date" name="doc_date" required style={{ width: "auto" }} />
                <input name="reference" placeholder={t.money.reference} style={{ width: 110 }} />
                <button className="btn btn-ghost btn-sm" name="op" value="transfer">{a.transfer}</button></form></div>))}</div>
        </section>
      )}

      <section className="section"><H>{a.orgs}</H>
        <div className="list">{(d.recent_orgs ?? []).map((o: any) => (
          <div className="item" key={o.id}><div className="grow"><div className="title">{o.name} <span className="badge">{t.common.orgType[o.type]}</span>{o.connected && <> <span className="badge badge-money">✓</span></>}</div>
            <div className="meta">{shortDate(o.created_at, locale)} · {t.nav.partners}: {o.partners} · {t.dash.recentSales}: {o.sales}{o.referred_by ? ` · ← ${o.referred_by}` : ""}</div></div></div>))}</div>
      </section>

      <section className="section"><H>{a.settings}</H>
        <div className="list">{["founding_partners_open", "founders_open"].map((k) => (
          <form action={adminAction} className="item" key={k}>{hidden}<input type="hidden" name="op" value="setting" /><input type="hidden" name="key" value={k} />
            <span className="title mono">{k}</span>
            <select name="value" defaultValue={String(d.settings?.[k])} style={{ width: "auto" }}><option value="true">true</option><option value="false">false</option></select>
            <button className="btn btn-ghost btn-sm">{t.common.save}</button></form>))}</div>
      </section>
    </AppShell>
  );
}
