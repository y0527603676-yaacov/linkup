import Link from "next/link";
import { redirect } from "next/navigation";
import { ChoiceButton } from "@/components/ChoiceButton";
import { AppShell, PageHead, Alert, Stat } from "@/components/AppShell";
import { loadApp } from "@/lib/orgs";
import { errorText, money, shortDate } from "@/lib/format";
import { Overview } from "./Overview";
import { adminAction, adminCloseConnectHelp } from "../actions";

export default async function Admin({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp);
  const { sb, org, isPlatformAdmin, t, locale } = ctx;
  if (!isPlatformAdmin) redirect(`/app?org=${org.id}`);
  const a = t.admin;
  const [{ data }, { data: ai }, { data: ld }, { data: cm }] = await Promise.all([sb.rpc("admin_overview"), sb.rpc("admin_invoices"),
    sb.rpc("legal_admin_documents"), sb.rpc("admin_contact_messages")]);
  const [{ data: fn }, { data: fd }, { data: exq }, { data: vb }] = await Promise.all([sb.rpc("admin_fee_notices"), sb.rpc("finance_dashboard"), sb.rpc("billing_exceptions"), sb.rpc("admin_vat_basis_pending")]);
  const vatPending = (vb ?? []) as any[];
  const tab = ["overview", "orgs", "finance", "settings"].includes(sp.tab ?? "") ? sp.tab! : "overview";
  const { data: pov } = tab === "overview" || tab === "orgs" ? await sb.rpc("admin_pilot_overview", { p_include_test: sp.test === "1" }) : { data: null };
  const { data: ts } = await sb.rpc("admin_test_signups");
  const [{ data: cf }, { data: chq }] = tab === "overview" ? await Promise.all([sb.rpc("connect_funnel_stats", { p_days: 30 }), sb.rpc("admin_connect_help")]) : [{ data: null }, { data: null }];
  const ac = t.uc.adminConnect; const C = (cf ?? null) as Record<string, any> | null; const helpReqs = (chq ?? []) as any[];
  const share = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");
  const testSignups = (ts ?? []) as { email: string; note: string | null; registered: boolean }[];
  const F = (fd ?? {}) as Record<string, any>;
  const exceptions = (exq ?? []) as any[];
  const bl = t.billing;
  const notices = (fn ?? []) as any[];
  const settings = ((data as any)?.settings ?? {}) as Record<string, any>;   // all settings, from admin_overview
  const legalDocs = (ld ?? []) as any[];
  const contacts = (cm ?? []) as any[];
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
      <nav className="tabs" aria-label={a.title} style={{ marginBottom: 16 }}>
        {(["overview", "orgs", "finance", "settings"] as const).map((k) => (
          <Link key={k} className={`tab${tab === k ? " on" : ""}`} href={`/app/admin?org=${org.id}&tab=${k}`} aria-current={tab === k ? "page" : undefined}>{a.tabs[k]}</Link>))}
      </nav>
      {tab === "overview" && C && (
        <section className="section"><H>{ac.title}</H>
          <div className="stats">
            <Stat label={ac.started} value={String(C.stores_started)} />
            <Stat label={ac.connected} value={String(C.connected)} />
            <Stat label={`${ac.self} (${ac.ofConnected})`} value={share(C.connected_self, C.connected)} />
            <Stat label={ac.notConnected} value={String(C.not_connected)} />
          </div>
          <p className="small muted">{ac.target} · {ac.guided}: {C.connected_guided} · {ac.assisted}: {C.connected_assisted}</p>
          {Object.keys(C.unsupported ?? {}).length > 0 && <p className="small">{ac.unsupported}: {Object.entries(C.unsupported).map(([k, v]) => `${k} ${v}`).join(" · ")}</p>}
          {(C.failure_reasons ?? []).length > 0 && <p className="small">{ac.reasons}: {(C.failure_reasons as any[]).map((r) => `${r.reason} (${r.stores})`).join(" · ")}</p>}
          <h3 style={{ marginBottom: 6 }}>{ac.help}</h3>
          {!helpReqs.length && <p className="small muted">{ac.noHelp}</p>}
          {helpReqs.map((h) => (
            <div key={h.id} className="card card-flat row between" style={{ gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
              <span className="small"><b>{h.org}</b> · {t.uc.help.channels[h.channel]} · <span className="ltr">{h.phone}</span>{h.preferred_time && <> · {h.preferred_time}</>}
                {h.site_host && <> · <span className="ltr">{h.site_host}</span></>}{h.platform && <> · {h.platform}</>}{h.note && <><br />{h.note}</>}</span>
              <form action={adminCloseConnectHelp}><input type="hidden" name="org" value={org.id} /><input type="hidden" name="id" value={h.id} />
                <button className="btn btn-ghost btn-sm">{ac.done}</button></form>
            </div>
          ))}
        </section>
      )}
      {tab === "overview" && pov && <Overview o={pov as any} a={a} locale={locale} orgParam={org.id} />}

      {tab === "finance" && <>
      <section className="section"><H>{bl.finance}</H>
        {!F.auto_enabled && <p className="small muted">{bl.off}</p>}
        <div className="stats">
          <Stat label={bl.stats.accrued} value={money(F.fees_accrued_month_minor, "ILS", locale)} />
          <Stat label={bl.stats.open} value={money(F.requests_open_minor, "ILS", locale)} />
          <Stat label={bl.stats.overdue} value={money(F.requests_overdue_minor, "ILS", locale)} />
          <Stat money label={bl.stats.collected} value={money(F.collected_month_minor, "ILS", locale)} />
          <Stat label={bl.stats.auto} value={money(F.auto_collected_month_minor, "ILS", locale)} />
          <Stat label={bl.stats.vat} value={money(F.vat_month_minor, "ILS", locale)} />
          <Stat label={bl.stats.refunds} value={money(F.refunds_month_minor, "ILS", locale)} />
          <Stat label={bl.stats.failed} value={F.charges_failed_final ?? 0} />
          <Stat label={bl.stats.methods} value={F.stores_with_method ?? 0} />
          <Stat label={bl.stats.rewards} value={money(F.rewards_liability_minor, "ILS", locale)} />
          <Stat label={bl.stats.creatorsDue} value={money(F.creator_outstanding_minor, "ILS", locale)} />
          <Stat label={bl.stats.creatorsOverdue} value={F.creator_overdue_pairs ?? 0} />
        </div>
      </section>

      <section className="section"><H>{bl.exceptions}</H>
        {exceptions.length === 0 ? <p className="empty">{bl.noExceptions}</p> : (
          <div className="list">{exceptions.map((x, k) => (
            <div className="item" key={k}>
              <div className="grow"><div className="title"><span className="badge badge-warn">{bl.exKinds[x.kind] ?? x.kind}</span> {x.org}</div>
                <div className="meta">{x.detail ?? ""}{x.since ? ` · ${shortDate(x.since, locale)}` : ""}</div></div>
              {x.action === "retry" && <form action={adminAction}>{hidden}<input type="hidden" name="op" value="retry" /><input type="hidden" name="id" value={x.ref} />
                <button className="btn btn-ghost btn-sm">{bl.retry}</button></form>}
              {x.action === "resolve" && x.kind === "charge_unknown" && (
                <form action={adminAction} className="stack" style={{ minWidth: 220 }}>{hidden}<input type="hidden" name="id" value={x.ref} />
                  <p className="small muted" style={{ margin: 0 }}>{bl.unknownHelp}</p>
                  <input name="ref" placeholder={bl.providerRef} /><input name="note" required placeholder={bl.resolveNote} />
                  <span className="row" style={{ gap: 6 }}><ChoiceButton className="btn btn-ghost btn-sm" name="op" value="resolve_paid">{bl.resolvePaid}</ChoiceButton>
                    <ChoiceButton className="btn btn-ghost btn-sm" name="op" value="resolve_failed">{bl.resolveFailed}</ChoiceButton></span></form>)}
              {x.action === "alert" && (
                <form action={adminAction} className="row" style={{ flexWrap: "wrap", gap: 6 }}>{hidden}<input type="hidden" name="op" value="alert" /><input type="hidden" name="id" value={x.ref} />
                  <input name="note" required placeholder={bl.alertNote} style={{ minWidth: 160 }} /><button className="btn btn-ghost btn-sm">{bl.alertHandled}</button></form>)}
            </div>))}</div>
        )}
      </section>

      <section className="section"><H>{a.invoices}</H>
        {!A.tax_approved && <Alert kind="warn" text={a.gated} />}
        {settings.reward_settlement_approved !== true && <Alert kind="warn" text={a.settlementGated} />}
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
              {(i.lines ?? []).length > 0 && <div className="small muted ltr">{(i.lines as any[]).map((ln) => `${pct(ln.rate_bps)} × ${money(ln.base_minor, i.currency, locale)}`).join(" · ")}</div>}
              {(i.charges ?? []).map((c: any) => (
                <div key={c.id} className="small row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <span>#{c.attempt} · {c.status === "scheduled" ? bl.charges.scheduled(shortDate(c.scheduled_for, locale)) : bl.charges[c.status]}{c.failure_message ? ` · ${c.failure_message}` : ""}{Number(c.refunded_minor) ? ` · ${bl.refund} ${money(c.refunded_minor, i.currency, locale)}` : ""}</span>
                  {c.status === "succeeded" && Number(c.refunded_minor) < Number(c.amount_minor) && (
                    <details><summary>{bl.refund}</summary>
                      <form action={adminAction} className="row" style={{ gap: 6, flexWrap: "wrap" }}>{hidden}<input type="hidden" name="op" value="refund" /><input type="hidden" name="id" value={c.id} />
                        <input name="amount" inputMode="decimal" required placeholder="₪" style={{ width: 80 }} dir="ltr" /><input name="reason" required placeholder={bl.refundReason} style={{ width: 160 }} />
                        <button className="btn btn-ghost btn-sm">{bl.refund}</button></form></details>)}
                </div>))}
              {(i.disputes ?? []).map((x: any) => (
                <div key={x.id} className="small alert alert-warn" style={{ margin: "6px 0" }}>
                  {a.disputes}: {money(x.disputed_minor, i.currency, locale)} · {x.reason}{x.evidence ? ` · ${x.evidence}` : ""}
                  {x.resolved_at ? <div>{t.money.disputeResolved} {x.resolution}</div> : (
                    <form action={adminAction} className="row" style={{ marginTop: 6 }}>{hidden}<input type="hidden" name="op" value="resolve" /><input type="hidden" name="id" value={x.id} />
                      <input name="resolution" required placeholder={a.resolution} style={{ flex: 1, minWidth: 140 }} /><button className="btn btn-ghost btn-sm">{a.resolve}</button></form>)}
                </div>))}
              <div className="row small">{i.missing_linkup_doc && <span className="badge badge-warn">{a.missingLinkup}</span>}{i.missing_counterparty_doc && <span className="badge badge-warn">{a.missingCounter}</span>}</div>
              {i.status === "issued" && !i.delivered_at && (
                <form action={adminAction} className="row" style={{ marginTop: 8 }}>{hidden}<input type="hidden" name="id" value={i.id} /><input type="hidden" name="op" value="delivered" />
                  <select name="method" aria-label={a.methodLabel} style={{ width: "auto" }}>{["email", "whatsapp", "in_app", "other"].map((k) => <option key={k} value={k}>{k}</option>)}</select>
                  <input type="datetime-local" name="at" style={{ width: "auto" }} /><input name="reference" placeholder={t.money.reference} style={{ width: 140 }} />
                  <button className="btn btn-ghost btn-sm">{a.markDelivered}</button></form>)}
              {i.status === "issued" && (
                <form action={adminAction} className="row" style={{ marginTop: 8 }}>{hidden}<input type="hidden" name="id" value={i.id} />
                  <input name="reference" placeholder={t.money.reference} style={{ width: 130 }} />
                  <ChoiceButton className="btn btn-primary btn-sm" name="op" value="paid">{a.markPaid}</ChoiceButton>
                  {!i.delivered_at && <ChoiceButton className="btn btn-danger btn-sm" name="op" value="void">{a.void}</ChoiceButton>}</form>)}
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

      {(A.wind_down ?? []).length > 0 && (
        <section className="section"><H>{a.windDown}</H>
          <div className="list">{(A.wind_down as any[]).map((w) => <div className="item" key={w.org_id}><span className="title">{w.org}</span></div>)}</div>
        </section>
      )}

      {notices.length > 0 && (
        <section className="section"><H>{a.notices}</H>
          <div className="stack">{notices.map((n) => (
            <div className="card card-flat stack small" key={n.term_id}>
              <b>{n.store} · {pct(n.fee_bps)} · {shortDate(n.effective_from, locale)} · {n.status}</b>
              <div>{n.delivered_at ? `${a.earliestStart}: ${shortDate(n.starts_at, locale)}` : a.notDelivered}</div>
              <ul style={{ margin: 0, paddingInlineStart: 18 }}>{(n.events ?? []).map((e: any, k: number) => (
                <li key={k}>{a.noticeEvent[e.event]} · {e.channel ?? ""} {e.recipient ? `· ${e.recipient}` : ""} {e.reference ? `· ${e.reference}` : ""} · {shortDate(e.at, locale)}</li>))}</ul>
              <form action={adminAction} className="row" style={{ flexWrap: "wrap" }}>{hidden}<input type="hidden" name="op" value="notice" /><input type="hidden" name="term" value={n.term_id} />
                <select name="event" style={{ width: "auto" }}>{["sent", "delivered", "failed"].map((k) => <option key={k} value={k}>{a.noticeEvent[k]}</option>)}</select>
                <select name="channel" style={{ width: "auto" }}>{["email", "whatsapp", "in_app", "registered_mail", "other"].map((k) => <option key={k} value={k}>{k}</option>)}</select>
                <input name="recipient" placeholder={a.recipient} style={{ width: 150 }} /><input name="reference" placeholder={a.noticeRef} style={{ width: 150 }} />
                <input type="datetime-local" name="at" style={{ width: "auto" }} /><button className="btn btn-ghost btn-sm">{a.recordNotice}</button></form>
              {n.status === "declined" && (n.wind_down ? (
                <form action={adminAction} className="row">{hidden}<input type="hidden" name="id" value={n.wind_down.id} />
                  <span>{a.planWindDown}: {shortDate(n.wind_down.end_at, locale)} · {n.wind_down.status}</span>
                  {n.wind_down.status === "planned" && <><ChoiceButton className="btn btn-ghost btn-sm" name="op" value="wd_complete">{a.complete}</ChoiceButton>
                    <ChoiceButton className="btn btn-ghost btn-sm" name="op" value="wd_cancel">{a.cancel}</ChoiceButton></>}</form>
              ) : settings.wind_down_notice_days == null ? <p className="alert alert-warn" style={{ margin: 0 }}>{a.windDownUndecided}</p> : (
                <form action={adminAction} className="row" style={{ flexWrap: "wrap" }}>{hidden}<input type="hidden" name="op" value="wd_plan" /><input type="hidden" name="term" value={n.term_id} />
                  <input type="date" name="end" required style={{ width: "auto" }} /><input name="note" required placeholder={a.note} style={{ flex: 1, minWidth: 140 }} />
                  <button className="btn btn-ghost btn-sm">{a.planWindDown}</button></form>))}
            </div>))}</div>
        </section>
      )}

      {vatPending.length > 0 && (
        <section className="section"><H>{a.vatBasisTitle}</H>
          <p className="small muted">{a.vatBasisLead}</p>
          <div className="stack">{vatPending.map((g) => (
            <form key={g.id} action={adminAction} className="card card-flat small row" style={{ flexWrap: "wrap", gap: 8 }}>{hidden}
              <input type="hidden" name="op" value="vatbasis" /><input type="hidden" name="id" value={g.id} />
              <b>{g.store} ↔ {g.creator} · {shortDate(g.created_at, locale)}</b>
              <input name="note" required placeholder={a.vatBasisNote} style={{ flex: 1, minWidth: 160 }} />
              <button className="btn btn-ghost btn-sm">{a.vatBasisDecide}</button></form>))}</div>
        </section>
      )}

      </>}

      {tab === "orgs" && <>
      <section className="section"><H>{a.orgs}</H>
        <p className="small muted">{sp.test === "1" ? a.ov.withTest : a.ov.realOnly((pov as any)?.test_orgs ?? 0)}{" "}
          <Link href={`/app/admin?org=${org.id}&tab=orgs${sp.test === "1" ? "" : "&test=1"}`}>{sp.test === "1" ? a.ov.showReal : a.ov.showTest}</Link></p>
        <div className="list">{(((pov as any)?.recent ?? []) as any[]).map((o) => (
          <div className="item" key={o.id}><div className="grow"><div className="title">{o.name} <span className="badge">{t.common.orgType[o.type]}</span>{o.is_test && <> <span className="badge badge-warn">{t.common.testAccount}</span></>}{o.connected && <> <span className="badge badge-money">✓</span></>}</div>
            <div className="meta">{shortDate(o.created_at, locale)} · {t.nav.partners}: {o.partners} · {t.dash.recentSales}: {o.sales}</div></div></div>))}</div>
      </section>

      <section className="section"><H>{a.testTitle}</H>
        <p className="small muted">{a.testLead}</p>
        <form action={adminAction} className="row" style={{ flexWrap: "wrap", gap: 8 }}>{hidden}<input type="hidden" name="op" value="test_add" />
          <input name="email" type="email" required dir="ltr" placeholder="name+store@gmail.com" style={{ flex: 2, minWidth: 200 }} />
          <input name="note" maxLength={200} placeholder={a.testNote} style={{ flex: 1, minWidth: 140 }} />
          <button className="btn btn-primary btn-sm">{a.testAdd}</button></form>
        {testSignups.length > 0 && <div className="list" style={{ marginTop: 12 }}>{testSignups.map((x) => (
          <div className="item" key={x.email}>
            <div className="grow"><div className="title ltr">{x.email}</div>{x.note && <div className="meta">{x.note}</div>}</div>
            <span className={`badge ${x.registered ? "badge-money" : ""}`}>{x.registered ? a.testRegistered : a.testWaiting}</span>
            <form action={adminAction}>{hidden}<input type="hidden" name="op" value="test_remove" /><input type="hidden" name="email" value={x.email} />
              <button className="btn btn-ghost btn-sm">{a.testRemove}</button></form>
          </div>))}</div>}
      </section>

      </>}

      {tab === "finance" && <>
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
                <input name="withholding" inputMode="decimal" placeholder={a.withholding} style={{ width: 170 }} />
                <input name="reference" placeholder={t.money.reference} style={{ width: 110 }} />
                <ChoiceButton className="btn btn-ghost btn-sm" name="op" value="transfer">{a.transfer}</ChoiceButton></form></div>))}</div>
        </section>
      )}

      </>}

      {tab === "settings" && <>
      <section className="section"><H>{a.settings}</H>
        <div className="list">{["founding_partners_open", "woo_api_connect_open"].map((k) => (
          <form action={adminAction} className="item" key={k}>{hidden}<input type="hidden" name="op" value="setting" /><input type="hidden" name="key" value={k} />
            <span className="title">{a.settingLabels[k] ?? k}</span>
            <select name="value" defaultValue={String(d.settings?.[k])} style={{ width: "auto" }}><option value="true">true</option><option value="false">false</option></select>
            <button className="btn btn-ghost btn-sm">{t.common.save}</button></form>))}</div>
      </section>
      <section className="section"><H>{a.wpPilot.title}</H>
        <p className="small muted">{a.wpPilot.note}</p>
        <form action={adminAction} className="item" style={{ flexWrap: "wrap", gap: 8 }}>{hidden}<input type="hidden" name="op" value="wp_pilot" />
          <select name="target" defaultValue={String(settings.wp_connect_pilot_org ?? "")} style={{ width: "auto", maxWidth: "100%" }}>
            <option value="">{a.wpPilot.none}</option>
            {stores.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button className="btn btn-ghost btn-sm">{t.common.save}</button>
          <span className="small muted" style={{ width: "100%" }}>{settings.wp_connect_pilot_org
            ? `${a.wpPilot.current}: ${stores.find((s: any) => s.id === settings.wp_connect_pilot_org)?.name ?? settings.wp_connect_pilot_org}`
            : a.wpPilot.closed}</span>
        </form>
      </section>
      <section className="section"><H>{t.legal.drafts}</H>
        <p className="small muted">{t.legal.draftNote}</p>
        <p className="small alert alert-warn">{a.nextVersionFix}</p>
        <div className="list">{legalDocs.map((x) => (
          <a className="item" key={x.id} href={`/legal/${x.doc_key}?lang=${x.locale}${x.status === "draft" ? `&draft=${x.version}` : ""}`}>
            <div className="grow"><div className="title">{x.title}</div>
              <div className="meta ltr">{x.doc_key} · {x.locale} · v{x.version}.0 · {x.audience} · {x.chars}</div></div>
            <span className={`badge ${x.status === "published" ? "badge-money" : "badge-warn"}`}>{x.status === "published" ? t.common.saved : t.legal.draftBadge}</span></a>))}</div>
      </section>

      {contacts.length > 0 && (
        <section className="section"><H>{a.contacts}</H>
          <div className="list">{contacts.map((c) => (
            <div className="item" key={c.id}>
              <div className="grow"><div className="title">{c.name} · <span className="ltr">{c.email}</span> · {t.contact.topics[c.topic]}</div>
                <div className="meta" style={{ whiteSpace: "pre-wrap" }}>{c.message}</div><div className="meta">{shortDate(c.created_at, locale)}</div></div>
              {c.handled_at ? <span className="badge">{a.handled}</span> : (
                <form action={adminAction}>{hidden}<input type="hidden" name="op" value="contact" /><input type="hidden" name="id" value={c.id} />
                  <button className="btn btn-ghost btn-sm">{a.handled}</button></form>)}
            </div>))}</div>
        </section>
      )}

      </>}
    </AppShell>
  );
}
