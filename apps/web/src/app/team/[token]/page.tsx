import Link from "next/link";
import { notFound } from "next/navigation";
import { Logo } from "@/components/Site";
import { Alert } from "@/components/AppShell";
import { getT } from "@/i18n";
import { getSupabase } from "@/lib/supabase/server";
import { errorText } from "@/lib/format";
import { acceptTeamInvite } from "@/app/app/actions";

export default async function TeamInvite({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { token } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f]{32}$/.test(token)) notFound();
  const { t } = await getT();
  const sb = await getSupabase();
  const { data } = await sb.rpc("get_team_invite", { p_token: token });
  const inv = data as { org_name: string; role: string; email: string; valid: boolean } | null;
  if (!inv) notFound();
  const { data: auth } = await sb.auth.getUser();
  return (
    <div className="auth-wrap"><div className="card stack">
      <Logo />
      <h1>{t.team.joinTitle(inv.org_name)}</h1>
      <p className="muted">{t.team.roles[inv.role]}</p>
      <Alert text={errorText(sp.error, t)} />
      {!inv.valid ? <p className="alert alert-error">{t.team.joinInvalid}</p>
        : !auth.user ? <><p className="small muted">{t.team.joinEmail(inv.email)}</p><Link className="btn btn-primary" href={`/login?next=${encodeURIComponent(`/team/${token}`)}`}>{t.common.login}</Link></>
        : <form action={acceptTeamInvite}><input type="hidden" name="token" value={token} /><button className="btn btn-primary btn-block">{t.team.joinCta}</button></form>}
    </div></div>
  );
}
