import { cookies } from "next/headers";
import { Logo } from "@/components/Site";
import { Alert } from "@/components/AppShell";
import { getT } from "@/i18n";
import { getSupabase } from "@/lib/supabase/server";
import { errorText } from "@/lib/format";
import { createOrg } from "../actions";
import { type PendingDoc } from "@/components/LegalChecks";
import { JoinForm } from "@/components/JoinForm";

export default async function NewActivity({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { t, locale } = await getT();
  const o = t.onboarding;
  const type = sp.type === "creator" ? "creator" : sp.type === "store" ? "store" : null;
  const ref = (await cookies()).get("lk_ref")?.value;
  const sb = await getSupabase();
  // Independent reads run together; both legal contexts load once so the store/creator switch needs no server trip.
  const [refRes, members, signup, creator] = await Promise.all([
    ref ? sb.rpc("referrer_name", { p_code: ref }) : Promise.resolve({ data: null }),
    sb.from("memberships").select("org_id", { count: "exact", head: true }),
    sb.rpc("legal_pending", { p_context: "signup" }),
    sb.rpc("legal_pending", { p_context: "creator" }),
  ]);
  const refName = (refRes.data as string | null) ?? null;
  const orgCount = members.count;
  return (
    <div className="auth-wrap">
      <div className="card stack">
        <Logo href="/app" />
        <h1>{orgCount ? o.titleAdd : o.title}</h1>
        <p className="muted">{o.lead}</p>
        {refName && <p className="badge badge-brand">{o.invitedBy(refName)}</p>}
        <Alert text={errorText(sp.error, t)} />
        <JoinForm initial={type} next={sp.next ?? ""} locale={locale} action={createOrg}
          signupDocs={(signup.data ?? []) as PendingDoc[]} creatorDocs={(creator.data ?? []) as PendingDoc[]}
          copy={{ store: o.store, creator: o.creator, storeName: o.storeName, creatorName: o.creatorName, website: o.website, create: o.create, legalLabel: t.lc.reg }} />
      </div>
    </div>
  );
}
