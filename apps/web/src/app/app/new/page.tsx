import { withBrand } from "@/components/Brand";
import { cookies } from "next/headers";
import { Logo } from "@/components/Site";
import { Alert } from "@/components/AppShell";
import { getT } from "@/i18n";
import { getSupabase } from "@/lib/supabase/server";
import { errorText } from "@/lib/format";
import { createOrg } from "../actions";
import { type PendingDoc } from "@/components/LegalChecks";
import { JoinForm } from "@/components/JoinForm";
import Link from "next/link";

type Quota = { used: number; max: number; today: number; per_day: number; grace_days: number;
  unset: { id: string; type: "store" | "creator"; name: string; created_at: string }[] };
const fill = (s: string, v: Record<string, number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));

export default async function NewActivity({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { t, locale } = await getT();
  const o = t.onboarding;
  const type = sp.type === "creator" ? "creator" : sp.type === "store" ? "store" : null;
  const ref = (await cookies()).get("lk_ref")?.value;
  const sb = await getSupabase();
  // Independent reads run together; both legal contexts load once so the store/creator switch needs no server trip.
  const [refRes, members, signup, creator, quotaRes] = await Promise.all([
    ref ? sb.rpc("referrer_name", { p_code: ref }) : Promise.resolve({ data: null }),
    sb.from("memberships").select("org_id", { count: "exact", head: true }),
    sb.rpc("legal_pending", { p_context: "signup" }),
    sb.rpc("legal_pending", { p_context: "creator" }),
    sb.rpc("my_activity_quota"),
  ]);
  const quota = (quotaRes.error ? null : quotaRes.data) as Quota | null;
  const daily = !!quota && quota.today >= quota.per_day;
  const ceiling = !!quota && quota.used >= quota.max;
  const blocked = daily || ceiling;
  const unset = (quota?.unset ?? []).slice(0, 5);
  const unsetList = unset.length > 0 && (
    <section className="stack" aria-labelledby="unset-h" style={{ gap: 8 }}>
      <h2 id="unset-h" style={{ fontSize: "1.05rem", margin: 0 }}>{o.unsetTitle}</h2>
      <p className="muted" style={{ margin: 0 }}>{o.unsetLead}</p>
      <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: 6 }}>
        {unset.map((a) => (
          <li key={a.id} className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <span><b>{a.name}</b> <small className="muted">· {a.type === "store" ? t.common.orgType.store : t.common.orgType.creator}</small></span>
            <Link className="btn btn-ghost btn-sm" href={a.type === "store" ? `/app/connect?org=${a.id}` : `/app/catalog?org=${a.id}`}>
              {a.type === "store" ? o.unsetStore : o.unsetCreator}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
  const refName = (refRes.data as string | null) ?? null;
  const orgCount = members.count;
  return (
    <div className="auth-wrap">
      <div className="card stack">
        <Logo href="/app" />
        <h1>{orgCount ? o.titleAdd : o.title}</h1>
        <p className="muted">{withBrand(o.lead)}</p>
        {refName && <p className="badge badge-brand">{o.invitedBy(refName)}</p>}
        {blocked && quota ? (
          <>
            <div className="alert alert-warn" role="status">
              <b>{o.limitTitle}</b>
              <p style={{ margin: "6px 0 0" }}>{daily ? fill(o.limitDaily, { n: quota.per_day }) : fill(o.limitCeiling, { used: quota.used, days: quota.grace_days })}</p>
            </div>
            {unsetList}
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <Link className="btn btn-primary" href="/app">{o.backToApp}</Link>
              {ceiling && !daily && <Link className="btn btn-ghost" href="/contact">{o.limitContact}</Link>}
            </div>
          </>
        ) : (<>
        <Alert text={errorText(sp.error, t)} />
        <JoinForm initial={type} next={sp.next ?? ""} locale={locale} action={createOrg}
          signupDocs={(signup.data ?? []) as PendingDoc[]} creatorDocs={(creator.data ?? []) as PendingDoc[]}
          copy={{ store: o.store, creator: o.creator, storeName: o.storeName, creatorName: o.creatorName, website: o.website, create: o.create, legalLabel: t.lc.reg }} />
        {unsetList}
        </>)}
      </div>
    </div>
  );
}
