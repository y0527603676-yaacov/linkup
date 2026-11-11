import { AppShell, PageHead } from "@/components/AppShell";
import { ShareButtons } from "@/components/ShareButtons";
import { loadApp } from "@/lib/orgs";
import { getOrigin } from "@/lib/supabase/server";
import { money, shortDate } from "@/lib/format";

type W = { program_open: boolean; activities: { org_id: string; name: string; type: string; referral_code: string; balance_minor: number; earned_minor: number; paid_minor: number }[];
  referrals: { name: string; type: string; joined_at: string; state: string; earning_until: string | null; first_sale_deadline: string; earned_minor: number }[] };

export default async function Rewards({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await loadApp(await searchParams);
  const { sb, org, t, locale } = ctx;
  const r = t.rewards;
  const { data } = await sb.rpc("my_wallet");
  const w = data as W;
  const origin = await getOrigin();
  const act = w.activities.find((a) => a.org_id === org.id) ?? w.activities[0];
  const total = w.activities.reduce((s, a) => s + Number(a.balance_minor), 0);
  const earned = w.activities.reduce((s, a) => s + Number(a.earned_minor), 0);
  const paid = w.activities.reduce((s, a) => s + Number(a.paid_minor), 0);
  return (
    <AppShell ctx={ctx} active="rewards" path="/app/rewards">
      <PageHead title={r.title} lead={r.lead} />
      {!w.program_open && <p className="alert alert-warn">{r.closed}</p>}
      <p className="small muted">{t.lc.referral} <a href="/legal/founding-partners">{t.legal.title}</a></p>
      <div className="card stack" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>{r.benefitTitle}</h2>
        <p style={{ margin: 0 }}>{r.benefitText}</p>
        <p className="small muted" style={{ margin: 0 }}>{r.splitNote}</p>
      </div>
      {act && (
        <div className="fp stack">
          <h2 style={{ letterSpacing: 0, margin: 0 }}>{r.link}</h2>
          <p className="small">{r.linkFor(act.name)}</p>
          {(["store", "creator"] as const).map((to) => {
            const link = `${origin}/join/${act.referral_code}?to=${to}`;
            return (
              <div key={to} className="stack" style={{ gap: 6 }}>
                <span className="small"><b>{to === "store" ? r.inviteStore : r.inviteCreator}</b></span>
                <div className="keybox" dir="ltr" style={{ background: "rgb(255 255 255 / .1)", color: "#fff" }}>{link}</div>
                <ShareButtons org={act.org_id} event="referral_link_shared" text={to === "store" ? r.waStore(link) : r.waCreator(link)} copyText={link}
                  labels={{ wa: to === "store" ? r.inviteStore : r.inviteCreator, copy: t.common.copy, copied: t.common.copied }} />
              </div>
            );
          })}
        </div>
      )}
      {w.referrals.length > 0 && (
        <section className="section stats">
          <div className="stat"><b>{w.referrals.length}</b><span>{r.kJoined}</span></div>
          <div className="stat money"><b>{money(earned, "ILS", locale)}</b><span>{r.kEarned}</span></div>
          <div className="stat"><b>{w.referrals.filter((x) => x.state === "waiting_first_sale").length}</b><span>{r.kWaiting}</span></div>
          <div className="stat"><b>{money(paid, "ILS", locale)}</b><span>{r.kPaid}</span></div>
        </section>
      )}
      {total !== 0 && <p className="small muted">{r.balance}: <b>{money(total, "ILS", locale)}</b></p>}
      <section className="section">
        <div className="section-head"><h2>{r.referrals}</h2></div>
        {w.referrals.length === 0 ? <p className="empty">{r.none}</p> : (
          <div className="list">
            {w.referrals.map((x, i) => (
              <div className="item" key={i}>
                <div className="grow"><div className="title">{x.name} <span className="badge">{t.common.orgType[x.type]}</span></div>
                  <div className="meta">{shortDate(x.joined_at, locale)} · {x.state === "earning" && x.earning_until ? r.until(shortDate(x.earning_until, locale))
                    : x.state === "waiting_first_sale" ? r.deadline(shortDate(x.first_sale_deadline, locale)) : ""}</div></div>
                {Number(x.earned_minor) !== 0 && <span className="amount">{money(x.earned_minor, "ILS", locale)}</span>}
                <span className={`badge ${x.state === "earning" ? "badge-money" : x.state === "waiting_first_sale" ? "badge-brand" : ""}`}>{r.state[x.state]}</span>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="section">
        <ul className="ticks small">{t.fp.rules.map((x) => <li key={x}>{x}</li>)}</ul>
      </section>
    </AppShell>
  );
}
