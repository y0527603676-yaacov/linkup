import Link from "next/link";
import { ChoiceButton } from "@/components/ChoiceButton";
import { AppShell, PageHead, Alert } from "@/components/AppShell";
import { loadApp } from "@/lib/orgs";
import { errorText, pct, shortDate } from "@/lib/format";
import { decideApplication } from "../actions";

export default async function Partners({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp, "store");
  const { sb, org, status, t, locale } = ctx;
  const p = t.partners;
  const q = `?org=${org.id}`;
  const [{ data: dash }, { data: apps }, { data: props }] = await Promise.all([
    sb.rpc("org_dashboard", { p_org: org.id }),
    sb.rpc("pending_applications", { p_store: org.id }),
    sb.from("proposals").select("token, invitee_name, status, commission_bps, created_at, expires_at").eq("from_org_id", org.id).order("created_at", { ascending: false }).limit(20),
  ]);
  const partners = ((dash as any)?.partners ?? []) as { name: string; code: string | null; commission_bps: number; created_at: string }[];
  const pending = ((apps ?? []) as unknown) as { id: string; creator: string; opportunity: string; message: string | null; created_at: string }[];
  return (
    <AppShell ctx={ctx} active="partners" path="/app/partners">
      <PageHead title={p.title}>{status.is_admin && <Link className="btn btn-primary btn-sm" href={`/app/invite${q}`}>{p.invite}</Link>}</PageHead>
      <Alert text={errorText(sp.error, t)} />
      {pending.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>{p.applications}</h2></div>
          <div className="list">
            {pending.map((a) => (
              <div className="item" key={a.id}>
                <div className="grow"><div className="title">{a.creator}</div>
                  <div className="meta">{a.opportunity} · {shortDate(a.created_at, locale)}{a.message ? ` · "${a.message}"` : ""}</div></div>
                {status.is_admin && (
                  <form action={decideApplication} className="row">
                    <input type="hidden" name="org" value={org.id} /><input type="hidden" name="id" value={a.id} />
                    <ChoiceButton className="btn btn-primary btn-sm" name="approve" value="1">{p.approve}</ChoiceButton>
                    <ChoiceButton className="btn btn-ghost btn-sm" name="approve" value="0">{p.reject}</ChoiceButton>
                  </form>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="section">
        <div className="section-head"><h2>{p.active}</h2></div>
        {partners.length === 0 ? (
          <div className="empty"><p>{p.noPartners}</p>{status.is_admin && <Link className="btn btn-primary" href={`/app/invite${q}`}>{p.invite}</Link>}</div>
        ) : (
          <div className="list">
            {partners.map((x) => (
              <div className="item" key={x.code ?? x.name}>
                <div className="grow"><div className="title">{x.name}</div><div className="meta">{shortDate(x.created_at, locale)}</div></div>
                <span className="row">{x.code && <span className="badge mono">{x.code}</span>}<span className="badge badge-money">{pct(x.commission_bps, locale)}</span></span>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="section">
        <div className="section-head"><h2>{p.sent}</h2></div>
        {(props ?? []).length === 0 ? <p className="empty">{p.noSent}</p> : (
          <div className="list">
            {(props ?? []).map((x) => {
              const st = (x.status === "sent" || x.status === "opened") && new Date(x.expires_at) < new Date() ? "expired" : x.status;
              return (
                <div className="item" key={x.token}>
                  <div className="grow"><div className="title">{x.invitee_name ?? "—"}</div><div className="meta">{shortDate(x.created_at, locale)} · {pct(x.commission_bps, locale)}</div></div>
                  <span className="row"><span className={`badge ${st === "accepted" ? "badge-money" : st === "opened" ? "badge-brand" : ""}`}>{p.proposalStatus[st]}</span>
                    {(st === "sent" || st === "opened") && <Link className="btn btn-ghost btn-sm" href={`/app/invite/sent${q}&token=${x.token}&name=${encodeURIComponent(x.invitee_name ?? "")}`}>{p.resend}</Link>}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </AppShell>
  );
}
