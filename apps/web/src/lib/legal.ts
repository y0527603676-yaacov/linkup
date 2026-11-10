import "server-only";
import { getSupabase } from "./supabase/server";

/** Operator details exactly as stated in the legal package (LINKUP_legal_package_2026-11-10.md). */
export const OPERATOR =
  "Operator / מפעיל: maayan shpergel, עוסק מורשה 037093390, trading as heleni jewelry. LINKUP is a brand, not a corporation. Address: yefe nof 37, sefat, israel. Email: y0527603676@gmail.com. Phone: 0525080979. Preferred channel: website contact form.";

export type Doc = { doc_key: string; locale: string; version: number; title: string; effective_from: string | null; published_at: string | null; sort_order: number };

/** Latest published, in-force version of each document; the viewer's language first, the other as fallback. */
export async function latestDocs(locale: string) {
  const sb = await getSupabase();
  const { data } = await sb.from("legal_documents").select("doc_key, locale, version, title, effective_from, published_at, sort_order")
    .eq("status", "published").order("version", { ascending: false });
  const now = Date.now();
  const best = new Map<string, Doc>();
  for (const d of (data ?? []) as Doc[]) {
    if (d.effective_from && new Date(d.effective_from).getTime() > now) continue;
    const cur = best.get(d.doc_key);
    if (!cur || d.version > cur.version || (d.version === cur.version && d.locale === locale && cur.locale !== locale)) best.set(d.doc_key, d);
  }
  return [...best.values()].sort((a, b) => a.sort_order - b.sort_order);
}

/** Documents whose single text is bilingual item by item (shown once, not as two language pages). */
export const BILINGUAL = new Set(["interface-notices"]);
