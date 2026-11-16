import { withBrand } from "@/components/Brand";
import { redirect } from "next/navigation";
import { Logo } from "@/components/Site";
import { Alert } from "@/components/AppShell";
import type { PendingDoc } from "@/components/LegalChecks";
import { getT } from "@/i18n";
import { getSupabase } from "@/lib/supabase/server";
import { errorText, safeNext } from "@/lib/format";
import { acceptPendingLegal } from "@/app/app/actions";

const titleOf = (d: PendingDoc, locale: string) => (locale === "he" ? d.title_he ?? d.title_en : d.title_en ?? d.title_he) ?? d.doc_key;

/**
 * One-time screen for existing users (and re-acceptance after a material change).
 * Calm by design: what applies, from when, and what does not change — then the documents and one consent per group.
 * Store terms are recorded against the store (hidden "org"), general terms against the person.
 */
export default async function AcceptLegal({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next || "/app");
  const sb = await getSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) redirect(`/login?next=${encodeURIComponent("/legal/accept")}`);
  const ctxs = (sp.ctx ?? "signup").split(",").filter((c) => ["signup", "store", "creator"].includes(c));
  const org = /^[0-9a-f-]{36}$/i.test(sp.org ?? "") ? sp.org! : "";
  // Store documents are pending per store (an acceptance for another store does not count).
  const lists = await Promise.all(ctxs.map((c) => (c === "store" && org ? sb.rpc("legal_pending_org", { p_org: org }) : sb.rpc("legal_pending", { p_context: c }))));
  const seen = new Set<string>();
  const docs = lists.flatMap((r) => (r.data ?? []) as PendingDoc[]).filter((d) => (seen.has(d.doc_key) ? false : (seen.add(d.doc_key), true)));
  if (!docs.length) redirect(next);
  const { t, locale } = await getT();
  const l = t.legal;
  const general = docs.filter((d) => d.audience !== "store");
  const store = docs.filter((d) => d.audience === "store");

  // Reassurance for a store: the founders period it already has, exactly as recorded.
  let foundersUntil: string | null = null;
  if (store.length && org) {
    const { data } = await sb.rpc("store_fee_terms", { p_store: org });
    const f = ((data as { terms?: { kind: string; effective_until: string | null }[] } | null)?.terms ?? [])
      .find((x) => x.kind === "founders" && x.effective_until && new Date(x.effective_until) > new Date());
    foundersUntil = f?.effective_until ?? null;
  }

  const DocList = ({ items, field }: { items: PendingDoc[]; field: string }) => (
    <div className="list">
      {items.map((d) => (
        <div className="item" key={d.doc_key}>
          <span className="title">{titleOf(d, locale)}</span>
          <a className="btn btn-ghost btn-sm" href={`/legal/${d.doc_key}`} target="_blank" rel="noopener">{l.acceptRead} ↗</a>
          <input type="hidden" name={field} value={d.doc_key} />
        </div>
      ))}
    </div>
  );
  const Consent = ({ name, text }: { name: string; text: string }) => (
    <label className="check small"><input type="checkbox" name={name} value="1" required style={{ width: "auto", marginTop: 4 }} /><span>{text}</span></label>
  );

  return (
    <div className="auth-wrap">
      <form action={acceptPendingLegal} className="card stack">
        <Logo href="/app" />
        <h1 style={{ marginBottom: 0 }}>{l.acceptTitle}</h1>
        <p className="lead" style={{ marginTop: 0 }}>{withBrand(l.acceptLead)}</p>
        <ul className="ticks small">{l.acceptCalm.map((x) => <li key={x}>{x}</li>)}</ul>
        {foundersUntil && <p className="small" style={{ margin: 0 }}><span className="badge badge-money">{l.acceptFounders(new Intl.DateTimeFormat(locale === "he" ? "he-IL" : "en-GB", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Jerusalem" }).format(new Date(foundersUntil)))}</span></p>}
        <Alert text={errorText(sp.error, t)} />
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="ctx" value={ctxs.join(",")} />
        {org && <input type="hidden" name="org" value={org} />}
        {general.length > 0 && (
          <div className="stack">
            <p className="eyebrow">{l.acceptDocsGeneral}</p>
            <DocList items={general} field="legal" />
            <Consent name="agree" text={t.lc.reg} />
          </div>
        )}
        {store.length > 0 && (
          <div className="stack">
            <p className="eyebrow">{l.acceptDocsStore}</p>
            <DocList items={store} field="legal_store" />
            <Consent name="agree_store" text={t.lc.store} />
          </div>
        )}
        <button className="btn btn-primary btn-block">{l.acceptCta}</button>
        <p className="muted small center" style={{ margin: 0 }}>{l.acceptHelp}</p>
      </form>
    </div>
  );
}
