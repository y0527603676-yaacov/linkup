import { redirect } from "next/navigation";
import { Logo } from "@/components/Site";
import { Alert } from "@/components/AppShell";
import { LegalChecks, type PendingDoc } from "@/components/LegalChecks";
import { getT } from "@/i18n";
import { getSupabase } from "@/lib/supabase/server";
import { errorText, safeNext } from "@/lib/format";
import { acceptPendingLegal } from "@/app/app/actions";

/** One-time screen for existing users (and re-acceptance after a material change). */
export default async function AcceptLegal({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next || "/app");
  const sb = await getSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) redirect(`/login?next=${encodeURIComponent("/legal/accept")}`);
  const ctxs = (sp.ctx ?? "signup").split(",").filter((c) => ["signup", "store", "creator"].includes(c));
  const lists = await Promise.all(ctxs.map((c) => sb.rpc("legal_pending", { p_context: c })));
  const seen = new Set<string>();
  const docs = lists.flatMap((r) => (r.data ?? []) as PendingDoc[]).filter((d) => (seen.has(d.doc_key) ? false : (seen.add(d.doc_key), true)));
  if (!docs.length) redirect(next);
  const { t, locale } = await getT();
  const l = t.legal;
  return (
    <div className="auth-wrap">
      <form action={acceptPendingLegal} className="card stack">
        <Logo href="/app" />
        <h1>{l.acceptTitle}</h1>
        <p className="muted">{l.acceptLead}</p>
        <Alert text={errorText(sp.error, t)} />
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="ctx" value={ctxs.join(",")} />
        <LegalChecks docs={docs.filter((d) => d.audience !== "store")} locale={locale} label={t.lc.reg} />
        {docs.some((d) => d.audience === "store") && (
          <div className="stack">
            {docs.filter((d) => d.audience === "store").map((d) => <input key={d.doc_key} type="hidden" name="legal_store" value={d.doc_key} />)}
            <ul className="small" style={{ margin: 0, paddingInlineStart: 18 }}>
              {docs.filter((d) => d.audience === "store").map((d) => <li key={d.doc_key}><a href={`/legal/${d.doc_key}`} target="_blank" rel="noopener">{(locale === "he" ? d.title_he ?? d.title_en : d.title_en ?? d.title_he) ?? d.doc_key}</a></li>)}
            </ul>
            <label className="row small" style={{ alignItems: "flex-start", gap: 8 }}><input type="checkbox" name="agree_store" value="1" required style={{ width: "auto", marginTop: 4 }} /><span>{t.lc.store}</span></label>
          </div>
        )}
        <button className="btn btn-primary btn-block">{l.acceptCta}</button>
      </form>
    </div>
  );
}
