import Link from "next/link";
import { redirect } from "next/navigation";
import { Alert, Shell } from "@/components/Shell";
import { CopyButton } from "@/components/CopyButton";
import { getMyOrgs, pickOrg } from "@/lib/orgs";
import { getOrigin, getSupabase } from "@/lib/supabase/server";
import { date, money, pct } from "@/lib/format";

type SP = Promise<Record<string, string | undefined>>;
/* eslint-disable @typescript-eslint/no-explicit-any */

const STATUS: Record<string, string> = { sent: "נשלחה", opened: "נפתחה", accepted: "אושרה ✓", rejected: "נדחתה", withdrawn: "בוטלה" };

export default async function Home({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const orgs = await getMyOrgs();
  if (orgs.length === 0) redirect("/app/new");
  const org = pickOrg(orgs, sp.org)!;
  const sb = await getSupabase();
  const { data: d } = await sb.rpc("org_dashboard", { p_org: org.id });
  const dash = d as any;
  const origin = await getOrigin();

  return (
    <Shell org={org} orgs={orgs}>
      {sp.accepted && <Alert kind="ok" text={org.type === "store" ? "השותפות פעילה! עכשיו חברו את החנות כדי שהקופון ייווצר." : "השותפות פעילה! הקישור והקופון שלך מוכנים למטה."} />}
      {org.type === "store" && dash && <StoreHome org={org} d={dash} origin={origin} />}
      {org.type === "creator" && dash && <CreatorHome org={org} d={dash} origin={origin} />}
      {org.type === "agency" && (
        <section className="card">
          <h1>{org.name}</h1>
          <p>ניהול משפיענים מיוצגים, פיצול עמלות והזמנת חנויות בשם המיוצגים נפתחים בשלב הבא.</p>
          <p className="muted">בינתיים: משפיען/ית שאתם מייצגים יכול/ה לפתוח חשבון ולקבל הצעות מחנויות.</p>
        </section>
      )}
    </Shell>
  );
}

function StoreHome({ org, d, origin }: { org: { id: string }; d: any; origin: string }) {
  const c = d.connection;
  const connected = c?.status === "connected";
  return (
    <>
      <div className="hero-row">
        <h1>{d.name}</h1>
        <Link className="btn btn-primary" href={`/app/invite?org=${org.id}`}>+ הזמנת משפיען/ית</Link>
      </div>
      {!connected && (
        <section className="card card-warn">
          <strong>{c ? "ממתינים לחיבור התוסף" : "החנות עוד לא מחוברת"}</strong>
          <p>בלי חיבור לא נוצרים קופונים ולא נספרות מכירות.</p>
          <Link className="btn btn-ghost btn-sm" href={`/app/connect?org=${org.id}`}>{c ? "הוראות חיבור / מפתח חדש" : "חיבור החנות (5 דקות)"}</Link>
        </section>
      )}
      <div className="stats">
        <Stat label="מכירות משותפים החודש" value={money(d.month_sales_minor, d.currency)} />
        <Stat label="עמלות ממתינות" value={money(d.pending_commissions_minor, d.currency)} hint="מאושרות אחרי חלון החזרות" />
        <Stat label="לתשלום לשותפים" value={money(d.approved_commissions_minor, d.currency)} />
        <Stat label="שותפים פעילים" value={String(d.active_partners)} />
      </div>
      <p className="muted small">עמלת LINKUP: {pct(d.fee_bps)} מהמכירות המיוחסות{d.founders_until ? ` (מחיר מייסדים עד ${date(d.founders_until)})` : ""} · החודש: {money(d.month_platform_fee_minor, d.currency)}</p>

      <section className="card">
        <h2>שותפים</h2>
        {d.partners.length === 0 ? <Empty text="עדיין אין שותפים. שלחו הזמנה ראשונה — זה לוקח פחות מדקה." /> : (
          <ul className="list">
            {d.partners.map((p: any) => (
              <li key={p.code ?? p.name}><span><strong>{p.name}</strong> · {pct(p.commission_bps)}</span><code dir="ltr">{p.code}</code></li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>מכירות אחרונות</h2>
        {d.recent_sales.length === 0 ? <Empty text="מכירות דרך שותפים יופיעו כאן אוטומטית." /> : (
          <ul className="list">
            {d.recent_sales.map((s: any) => (
              <li key={s.external_order_id}>
                <span>#{s.external_order_id} · {s.partner} · {s.method === "coupon" ? "קופון" : "קישור"}{s.self_referral_suspected ? " · ⚠️ ייתכן רכישה עצמית" : ""}<br /><small className="muted">{date(s.order_created_at)}</small></span>
                <span className="num">{money(s.base_minor, d.currency)}<br /><small className="muted">עמלה {money(s.commission_minor, d.currency)}</small></span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Proposals list={d.proposals} origin={origin} />
    </>
  );
}

function CreatorHome({ org, d, origin }: { org: { id: string }; d: any; origin: string }) {
  return (
    <>
      <div className="hero-row">
        <h1>{d.name}</h1>
        <Link className="btn btn-primary" href={`/app/invite?org=${org.id}`}>+ הזמנת חנות</Link>
      </div>
      <div className="stats">
        <Stat label="רווחים החודש" value={money(d.month_earnings_minor)} />
        <Stat label="ממתין לאישור" value={money(d.pending_minor)} hint="אחרי חלון ההחזרות" />
        <Stat label="מאושר לתשלום" value={money(d.approved_minor)} hint="החנות משלמת ישירות" />
        <Stat label="חנויות פעילות" value={String(d.active_stores)} />
      </div>

      <section className="card">
        <h2>הקישורים והקופונים שלך</h2>
        {d.partnerships.length === 0 ? <Empty text="עדיין אין שותפויות. הזמינו חנות שאתם כבר אוהבים — ההצעה מוכנה תוך דקה." /> : (
          <ul className="list">
            {d.partnerships.map((p: any) => {
              const link = `${origin}/r/${p.code}`;
              return (
                <li key={p.code} className="stacked">
                  <span><strong>{p.store_name}</strong> · עמלה {pct(p.commission_bps)} · הנחה {p.coupon_discount_pct}%
                    {!p.store_connected && <small className="muted"><br />הקופון יופעל ברגע שהחנות תסיים להתחבר</small>}</span>
                  <div className="actions">
                    <code dir="ltr">{p.code}</code>
                    <CopyButton text={p.code} label="העתקת קופון" />
                    <CopyButton text={link} label="העתקת קישור" />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>מכירות אחרונות</h2>
        {d.recent_sales.length === 0 ? <Empty text="כל מכירה עם הקופון או הקישור שלך תופיע כאן." /> : (
          <ul className="list">
            {d.recent_sales.map((s: any, i: number) => (
              <li key={i}><span>{s.store_name} · {s.method === "coupon" ? "קופון" : "קישור"}<br /><small className="muted">{date(s.order_created_at)}</small></span>
                <span className="num">{money(s.commission_minor)}</span></li>
            ))}
          </ul>
        )}
      </section>

      <Proposals list={d.proposals} origin={origin} />
    </>
  );
}

function Proposals({ list, origin }: { list: any[]; origin: string }) {
  if (!list?.length) return null;
  return (
    <section className="card">
      <h2>הזמנות ששלחת</h2>
      <ul className="list">
        {list.map((p) => (
          <li key={p.token}>
            <span>{p.invitee_name ?? "ללא שם"} · {pct(p.commission_bps)}<br /><small className="muted">{STATUS[p.status] ?? p.status} · {date(p.created_at)}</small></span>
            {p.status !== "accepted" && <CopyButton text={`${origin}/o/${p.token}`} label="העתקת קישור" />}
          </li>
        ))}
      </ul>
    </section>
  );
}

const Stat = ({ label, value, hint }: { label: string; value: string; hint?: string }) => (
  <div className="stat"><span className="muted small">{label}</span><strong>{value}</strong>{hint && <small className="muted">{hint}</small>}</div>
);
const Empty = ({ text }: { text: string }) => <p className="empty">{text}</p>;
