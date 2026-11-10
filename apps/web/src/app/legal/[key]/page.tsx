import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicPage } from "@/components/Site";
import { getT } from "@/i18n";
import { getSupabase } from "@/lib/supabase/server";
import { latestDocs, OPERATOR } from "@/lib/legal";
import { shortDate } from "@/lib/format";

type Row = { locale: string; version: number; title: string; body: string; effective_from: string | null; published_at: string | null; status?: string };

export default async function LegalDoc({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { key } = await params;
  const sp = await searchParams;
  if (!/^[a-z][a-z0-9_-]{1,40}$/.test(key)) notFound();
  const { t, locale } = await getT();
  const l = t.legal;
  const sb = await getSupabase();
  const want = sp.lang === "he" || sp.lang === "en" ? sp.lang : locale;
  let doc: Row | null = null;
  let draft = false;
  if (sp.draft) {
    // Platform admins can review drafts before approval; for everyone else the RPC refuses.
    const { data } = await sb.rpc("legal_admin_document", { p_key: key, p_locale: want, p_version: Number(sp.draft) || 1 });
    doc = (data as Row | null) ?? null;
    draft = !!doc && doc.status !== "published";
  } else {
    const { data } = await sb.from("legal_documents").select("locale, version, title, body, effective_from, published_at")
      .eq("doc_key", key).eq("status", "published").order("version", { ascending: false });
    const now = Date.now();
    const rows = ((data ?? []) as Row[]).filter((d) => !d.effective_from || new Date(d.effective_from).getTime() <= now);
    const v = sp.v ? Number(sp.v) : rows[0]?.version;
    const same = rows.filter((d) => d.version === v);
    doc = same.find((d) => d.locale === want) ?? same[0] ?? null;
  }
  if (!doc) notFound();
  const others = draft ? [] : (await latestDocs(locale)).filter((d) => d.doc_key !== key);
  const otherLang = doc.locale === "he" ? "en" : "he";
  const qs = (lang: string) => `?lang=${lang}${sp.draft ? `&draft=${sp.draft}` : ""}${sp.v ? `&v=${sp.v}` : ""}`;
  return (
    <PublicPage path={`/legal/${key}`}>
      <article className="container" style={{ padding: "40px 16px 80px", maxWidth: 760 }} dir={doc.locale === "he" ? "rtl" : "ltr"} lang={doc.locale}>
        <p className="small row between"><Link href="/legal">{l.back}</Link><Link href={`/legal/${key}${qs(otherLang)}`}>{otherLang === "en" ? "English" : "עברית"}</Link></p>
        {draft && <p className="alert alert-warn">{l.draftBadge}</p>}
        <h1>{doc.title}</h1>
        <p className="small muted">{l.ver(doc.version)}{doc.effective_from || doc.published_at ? ` · ${l.effective(shortDate(doc.effective_from ?? doc.published_at!, locale))}` : ""}</p>
        <div className="legal-body" style={{ whiteSpace: "pre-wrap", lineHeight: 1.75, overflowWrap: "anywhere", unicodeBidi: "plaintext" }}>
          {/* The stored text is shown exactly; only the source's **bold** markers are rendered as bold. */}
          {doc.body.split(/(\*\*[^*\n]+\*\*)/g).map((part, k) => /^\*\*[^*\n]+\*\*$/.test(part) ? <b key={k}>{part.slice(2, -2)}</b> : part)}
        </div>
        <p className="small muted" dir="ltr" style={{ marginTop: 24, overflowWrap: "anywhere" }}>{OPERATOR}</p>
        {others.length > 0 && (
          <nav className="card card-flat small" style={{ marginTop: 16 }}>
            <b>{l.otherDocs}</b>
            <ul style={{ margin: "8px 0 0", paddingInlineStart: 18 }}>{others.map((d) => <li key={d.doc_key}><Link href={`/legal/${d.doc_key}`}>{d.title}</Link></li>)}</ul>
          </nav>
        )}
      </article>
    </PublicPage>
  );
}
