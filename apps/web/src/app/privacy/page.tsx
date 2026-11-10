import type { Metadata } from "next";
import { PublicPage } from "@/components/Site";
import { redirect } from "next/navigation";
import { getT } from "@/i18n";
import { getSupabase } from "@/lib/supabase/server";

export const metadata: Metadata = { robots: { index: false, follow: false } };

// Placeholder until the lawyer-approved text is supplied (plan task T17). Shown honestly as a draft.
export default async function Page() {
  const { data: pub } = await (await getSupabase()).from("legal_documents").select("id").eq("doc_key", "privacy").eq("status", "published").limit(1);
  if (pub?.length) redirect("/legal/privacy");   // the approved, published version replaces this placeholder
  const { t, locale } = await getT();
  return (
    <PublicPage path="/privacy">
      <section className="container" style={{ padding: "40px 16px 80px", maxWidth: 760 }}>
        <h1>{t.common.privacy}</h1>
        <p className="alert alert-warn">{locale === "he"
          ? "הנוסח המלא נמצא בעריכה משפטית ויפורסם לפני הפתיחה הרחבה."
          : "The full text is under legal review and will be published before the public launch."}</p>
      </section>
    </PublicPage>
  );
}
