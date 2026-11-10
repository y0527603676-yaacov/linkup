import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicPage } from "@/components/Site";
import { getT } from "@/i18n";
import { getSupabase } from "@/lib/supabase/server";
import { shortDate } from "@/lib/format";

export default async function LegalDoc({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { key } = await params;
  const sp = await searchParams;
  if (!/^[a-z][a-z0-9_-]{1,40}$/.test(key)) notFound();
  const { t, locale } = await getT();
  const sb = await getSupabase();
  const { data } = await sb.from("legal_documents").select("locale, version, title, body, effective_from, published_at")
    .eq("doc_key", key).eq("status", "published").order("version", { ascending: false });
  const now = Date.now();
  const rows = (data ?? []).filter((d) => !d.effective_from || new Date(d.effective_from).getTime() <= now);
  if (!rows.length) notFound();
  const wantV = sp.v ? Number(sp.v) : rows[0]!.version;
  const sameV = rows.filter((d) => d.version === wantV);
  const doc = sameV.find((d) => d.locale === locale) ?? sameV[0] ?? rows[0]!;
  const dir = doc.locale === "he" ? "rtl" : "ltr";
  return (
    <PublicPage path={`/legal/${key}`}>
      <article className="container" style={{ padding: "40px 16px 80px", maxWidth: 760 }} dir={dir} lang={doc.locale}>
        <p className="small"><Link href="/legal">{t.legal.back}</Link></p>
        <h1>{doc.title}</h1>
        <p className="small muted">{t.legal.version(doc.version, shortDate(doc.effective_from ?? doc.published_at ?? new Date().toISOString(), locale))}</p>
        <div className="legal-body" style={{ whiteSpace: "pre-wrap", lineHeight: 1.75, overflowWrap: "anywhere" }}>{doc.body}</div>
      </article>
    </PublicPage>
  );
}
