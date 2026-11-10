import { cookies } from "next/headers";
import Link from "next/link";
import { Logo } from "@/components/Site";
import { Alert } from "@/components/AppShell";
import { getT } from "@/i18n";
import { getSupabase } from "@/lib/supabase/server";
import { errorText } from "@/lib/format";
import { createOrg } from "../actions";
import { LegalChecks, type PendingDoc } from "@/components/LegalChecks";

export default async function NewActivity({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { t, locale } = await getT();
  const o = t.onboarding;
  const type = sp.type === "creator" ? "creator" : sp.type === "store" ? "store" : null;
  const ref = (await cookies()).get("lk_ref")?.value;
  const sb = await getSupabase();
  let refName: string | null = null;
  if (ref) { const { data } = await sb.rpc("referrer_name", { p_code: ref }); refName = (data as string) ?? null; }
  const { count: orgCount } = await sb.from("memberships").select("org_id", { count: "exact", head: true });
  const ctxs = type === "creator" ? ["signup", "creator"] : ["signup"];
  const lists = await Promise.all(ctxs.map((c) => sb.rpc("legal_pending", { p_context: c })));
  const pending = lists.flatMap((r) => (r.data ?? []) as PendingDoc[]);
  return (
    <div className="auth-wrap">
      <div className="card stack">
        <Logo href="/app" />
        <h1>{orgCount ? o.titleAdd : o.title}</h1>
        <p className="muted">{o.lead}</p>
        {refName && <p className="badge badge-brand">{o.invitedBy(refName)}</p>}
        <Alert text={errorText(sp.error, t)} />
        <div className="pill-toggle" role="tablist">
          <Link role="tab" className={type === "store" ? "on" : ""} href={`/app/new?type=store${sp.next ? `&next=${encodeURIComponent(sp.next)}` : ""}`}>{o.store.t}</Link>
          <Link role="tab" className={type === "creator" ? "on" : ""} href={`/app/new?type=creator${sp.next ? `&next=${encodeURIComponent(sp.next)}` : ""}`}>{o.creator.t}</Link>
        </div>
        {type ? (
          <form action={createOrg} className="stack">
            <p className="muted small">{type === "store" ? o.store.d : o.creator.d}</p>
            <input type="hidden" name="type" value={type} />
            <input type="hidden" name="next" value={sp.next ?? ""} />
            <label className="field"><span>{type === "store" ? o.storeName : o.creatorName}</span>
              <input name="name" required minLength={2} maxLength={80} autoFocus /></label>
            {type === "store" && (
              <label className="field"><span>{o.website}</span>
                <input name="website" dir="ltr" inputMode="url" placeholder="myshop.co.il" /></label>
            )}
            <LegalChecks docs={pending} locale={locale} label={t.lc.reg} />
            <button className="btn btn-primary btn-block">{o.create}</button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
