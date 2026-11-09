import type { Metadata } from "next";
import { PublicPage } from "@/components/Site";
import { getT } from "@/i18n";

export const metadata: Metadata = { robots: { index: false, follow: false } };

// Placeholder until the lawyer-approved text is supplied (plan task T17). Shown honestly as a draft.
export default async function Page() {
  const { t, locale } = await getT();
  return (
    <PublicPage path="/terms">
      <section className="container" style={{ padding: "40px 16px 80px", maxWidth: 760 }}>
        <h1>{t.common.terms}</h1>
        <p className="alert alert-warn">{locale === "he"
          ? "הנוסח המלא נמצא בעריכה משפטית ויפורסם לפני הפתיחה הרחבה."
          : "The full text is under legal review and will be published before the public launch."}</p>
      </section>
    </PublicPage>
  );
}
