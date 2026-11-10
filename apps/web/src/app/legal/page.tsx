import type { Metadata } from "next";
import Link from "next/link";
import { PublicPage } from "@/components/Site";
import { getT } from "@/i18n";
import { latestDocs } from "@/lib/legal";
import { shortDate } from "@/lib/format";

export const metadata: Metadata = { title: "Legal" };

export default async function LegalCenter() {
  const { t, locale } = await getT();
  const l = t.legal;
  const docs = await latestDocs(locale);
  return (
    <PublicPage path="/legal">
      <section className="container" style={{ padding: "40px 16px 80px", maxWidth: 760 }}>
        <h1>{l.title}</h1>
        <p className="muted">{l.lead}</p>
        {docs.length === 0 ? <p className="alert alert-warn">{l.none}</p> : (
          <div className="list">
            {docs.map((d) => (
              <Link className="item" key={d.doc_key} href={`/legal/${d.doc_key}`}>
                <div className="grow"><div className="title">{d.title}</div>
                  <div className="meta">{l.version(d.version, shortDate(d.effective_from ?? d.published_at ?? new Date().toISOString(), locale))}</div></div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </PublicPage>
  );
}
