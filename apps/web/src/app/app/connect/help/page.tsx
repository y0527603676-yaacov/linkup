import Link from "next/link";
import { AppShell, PageHead, Alert } from "@/components/AppShell";
import { loadApp } from "@/lib/orgs";
import { errorText, shortDate } from "@/lib/format";
import { cancelConnectHelp, requestConnectHelp } from "../../actions";

/** "Help me connect": phone call, screen share, or remote control with consent. No passwords or payment details. */
export default async function ConnectHelp({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp, "store");
  const { sb, org, t, locale } = ctx;
  const h = t.uc.help;
  const { data: open } = await sb.rpc("my_connect_help", { p_org: org.id });
  const req = open as { id: string; channel: string; preferred_time: string | null; created_at: string } | null;
  return (
    <AppShell ctx={ctx} active="settings" path="/app/connect/help">
      <div className="narrow">
        <PageHead title={h.title} lead={h.lead} />
        <Alert text={errorText(sp.error, t)} />
        {sp.ok === "sent" && <Alert kind="ok" text={h.sent} />}
        {req ? (
          <section className="card stack">
            <p style={{ margin: 0 }}><b>{h.openTitle}</b></p>
            <p className="small" style={{ margin: 0 }}>{h.channels[req.channel]} · {shortDate(req.created_at, locale)}{req.preferred_time && <> · {req.preferred_time}</>}</p>
            <p className="small muted" style={{ margin: 0 }}>{h.openNote}</p>
            <form action={cancelConnectHelp}><input type="hidden" name="org" value={org.id} /><input type="hidden" name="id" value={req.id} />
              <button className="btn btn-ghost btn-sm">{h.cancel}</button></form>
          </section>
        ) : (
          <form action={requestConnectHelp} className="card stack">
            <input type="hidden" name="org" value={org.id} />
            <input type="hidden" name="site" value={sp.site ?? ""} />
            <input type="hidden" name="platform" value={sp.p ?? ""} />
            <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 8 }}>
              <legend className="small"><b>{h.how}</b></legend>
              {(["phone", "screen_share", "remote"] as const).map((c, i) => (
                <label key={c} className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                  <input type="radio" name="channel" value={c} defaultChecked={i === 0} required style={{ marginTop: 4 }} />
                  <span><b>{h.channels[c]}</b><br /><span className="small muted">{h.channelDesc[c]}</span></span>
                </label>
              ))}
            </fieldset>
            <label className="row small" style={{ gap: 8, alignItems: "flex-start" }}>
              <input type="checkbox" name="consent" value="1" style={{ marginTop: 3 }} />
              <span>{h.consent}</span>
            </label>
            <label className="field"><span>{h.phone}</span><input name="phone" required type="tel" inputMode="tel" dir="ltr" autoComplete="tel" /></label>
            <label className="field"><span>{h.time}</span><input name="time" maxLength={80} placeholder={h.timePh} /></label>
            <label className="field"><span>{h.note}</span><textarea name="note" rows={3} maxLength={500} /></label>
            <button className="btn btn-primary">{h.submit}</button>
            <p className="small muted" style={{ margin: 0 }}>{h.privacy}</p>
          </form>
        )}
        <p className="small" style={{ marginTop: 16 }}><Link href={`/app/connect?org=${org.id}`}>{h.back}</Link></p>
      </div>
    </AppShell>
  );
}
