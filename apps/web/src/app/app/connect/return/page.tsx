import Link from "next/link";
import { AppShell, PageHead } from "@/components/AppShell";
import { loadApp } from "@/lib/orgs";

/** WooCommerce sends the store owner back here after "Approve" / "Deny". Refreshes itself until the first sync is done. */
export default async function ConnectReturn({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp, "store");
  const { sb, org, t } = ctx;
  const l = t.connect;
  const denied = sp.success === "0";
  const { data } = !denied && sp.state ? await sb.rpc("woo_api_request_status", { p_state: sp.state }) : { data: null };
  const s = data as { completed: boolean; expired: boolean; status: string | null; last_error: string | null; products: number } | null;
  const done = s?.status === "connected";
  const waiting = !denied && s && !s.expired && !done && !s.last_error;
  return (
    <AppShell ctx={ctx} active="settings" path="/app/connect">
      {waiting && <meta httpEquiv="refresh" content="3" />}
      <div className="narrow stack">
        <PageHead title={denied ? l.retDenied : done ? l.retDone : s?.last_error ? l.retProblem : l.retWaiting} />
        {denied && <p className="muted">{l.retDeniedText}</p>}
        {waiting && <p className="muted" aria-live="polite">{s?.completed ? l.retSyncing : l.retAwaitKeys}</p>}
        {s?.expired && !s.completed && <p className="alert alert-warn">{l.retExpired}</p>}
        {s?.last_error && <p className="alert alert-warn">{l.errors[s.last_error] ?? l.errors.other}</p>}
        {done && <p className="muted">{l.retDoneText.replace("{n}", String(s?.products ?? 0))}</p>}
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {done ? <Link className="btn btn-primary" href={`/app/offer?org=${org.id}`}>{l.retNext}</Link>
                : <Link className="btn btn-ghost" href={`/app/connect?org=${org.id}`}>{l.retBack}</Link>}
          {done && <Link className="btn btn-ghost" href={`/app?org=${org.id}`}>{l.done}</Link>}
        </div>
      </div>
    </AppShell>
  );
}
