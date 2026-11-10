import { redirect } from "next/navigation";
import { ChoiceButton } from "@/components/ChoiceButton";
import { AppShell, PageHead, Alert } from "@/components/AppShell";
import { CopyButton } from "@/components/CopyButton";
import { loadApp } from "@/lib/orgs";
import { getOrigin } from "@/lib/supabase/server";
import { errorText } from "@/lib/format";
import { inviteTeam, teamAction } from "../actions";

type M = { members: { user_id: string; email: string; role: string; is_me: boolean }[]; invites: { id: string; email: string; role: string; token: string }[] };

export default async function Team({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp);
  const { sb, org, status, t } = ctx;
  if (!status.is_admin) redirect(`/app?org=${org.id}`);
  const l = t.team;
  const { data } = await sb.rpc("org_members", { p_org: org.id });
  const d = data as M;
  const origin = await getOrigin();
  const amOwner = org.role === "owner";
  return (
    <AppShell ctx={ctx} active="team" path="/app/team">
      <PageHead title={l.title} lead={l.lead} />
      <Alert text={errorText(sp.error, t)} />
      {sp.token && /^[0-9a-f]{32}$/.test(sp.token) && (
        <div className="card stack" style={{ marginBottom: 16 }}>
          <p className="small">{l.linkReady}</p>
          <div className="keybox" dir="ltr">{`${origin}/team/${sp.token}`}</div>
          <CopyButton text={`${origin}/team/${sp.token}`} label={t.common.copy} done={t.common.copied} />
        </div>
      )}
      <div className="list">
        {d.members.map((m) => (
          <div className="item" key={m.user_id}>
            <div className="grow"><div className="title ltr">{m.email}</div><div className="meta">{l.roles[m.role]}{m.is_me ? ` · ${l.you}` : ""}</div></div>
            {amOwner && !m.is_me && (
              <form action={teamAction} className="row">
                <input type="hidden" name="org" value={org.id} /><input type="hidden" name="user" value={m.user_id} />
                <select name="role" defaultValue={m.role} aria-label={l.role} style={{ width: "auto" }}>
                  {["owner", "admin", "member"].map((r) => <option key={r} value={r}>{l.roles[r]}</option>)}
                </select>
                <ChoiceButton className="btn btn-ghost btn-sm" name="op" value="role">{t.common.save}</ChoiceButton>
                <ChoiceButton className="btn btn-danger btn-sm" name="op" value="remove">{l.remove}</ChoiceButton>
              </form>
            )}
          </div>
        ))}
      </div>
      {d.invites.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>{l.pending}</h2></div>
          <div className="list">
            {d.invites.map((i) => (
              <div className="item" key={i.id}>
                <div className="grow"><div className="title ltr">{i.email}</div><div className="meta">{l.roles[i.role]}</div></div>
                <span className="row"><CopyButton text={`${origin}/team/${i.token}`} label={t.common.copy} done={t.common.copied} />
                  <form action={teamAction}><input type="hidden" name="org" value={org.id} /><input type="hidden" name="id" value={i.id} />
                    <ChoiceButton className="btn btn-danger btn-sm" name="op" value="revoke">{l.revoke}</ChoiceButton></form></span>
              </div>
            ))}
          </div>
        </section>
      )}
      <form action={inviteTeam} className="card stack section">
        <input type="hidden" name="org" value={org.id} />
        <div className="fields-2">
          <label className="field"><span>{l.email}</span><input name="email" type="email" required dir="ltr" maxLength={200} /></label>
          <label className="field"><span>{l.role}</span>
            <select name="role" defaultValue="member">
              <option value="member">{l.roles.member}</option>
              {amOwner && <option value="admin">{l.roles.admin}</option>}
            </select></label>
        </div>
        <button className="btn btn-primary">{l.invite}</button>
      </form>
    </AppShell>
  );
}
