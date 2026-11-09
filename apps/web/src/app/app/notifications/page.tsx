import { AppShell, PageHead } from "@/components/AppShell";
import { loadApp } from "@/lib/orgs";
import { money, shortDate } from "@/lib/format";
import { markRead } from "../actions";

export default async function Notifications({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await loadApp(await searchParams);
  const { sb, org, status, t, locale } = ctx;
  const n = t.notifications;
  const { data } = await sb.from("notifications").select("id, kind, payload, created_at, read_at").eq("org_id", org.id).order("created_at", { ascending: false }).limit(50);
  const detail = (p: Record<string, any>) =>
    [p.partner, p.store, p.creator, p.name, p.title, p.opportunity, p.amount_minor != null ? money(p.amount_minor, p.currency ?? "ILS", locale) : null,
     p.total_minor != null ? money(p.total_minor, p.currency ?? "ILS", locale) : null].filter(Boolean).join(" · ");
  return (
    <AppShell ctx={ctx} active="notifications" path="/app/notifications">
      <PageHead title={n.title}>
        {status.unread > 0 && <form action={markRead}><input type="hidden" name="org" value={org.id} /><button className="btn btn-ghost btn-sm">{n.markRead}</button></form>}
      </PageHead>
      {(data ?? []).length === 0 ? <p className="empty">{n.empty}</p> : (
        <div className="list">
          {(data ?? []).map((x) => (
            <div className="item" key={x.id} style={x.read_at ? undefined : { background: "var(--brand-soft)" }}>
              <div className="grow"><div className="title">{n.kinds[x.kind] ?? x.kind}</div><div className="meta">{detail(x.payload as Record<string, any>)}</div></div>
              <span className="meta small">{shortDate(x.created_at, locale)}</span>
            </div>
          ))}
        </div>
      )}
    </AppShell>
  );
}
