import type { Metadata } from "next";
import Link from "next/link";
import { PublicPage } from "@/components/Site";
import { getT } from "@/i18n";

export const metadata: Metadata = { title: "Founding Partners" };

export default async function FoundingPartners() {
  const { t } = await getT();
  return (
    <PublicPage path="/founding-partners">
      <section className="container" style={{ padding: "40px 16px 64px", maxWidth: 820 }}>
        <div className="fp">
          <p className="eyebrow fp-eyebrow">{t.fp.title}</p>
          <h1 style={{ margin: "6px 0 10px" }}>{t.fp.headline}</h1>
          <p className="lead" style={{ color: "rgb(255 255 255 / .9)" }}>{t.fp.lead}</p>
          <p className="small fp-note" style={{ margin: "8px 0 0" }}>{t.fp.split}</p>
          <ul className="ticks" style={{ margin: "20px 0" }}>{t.fp.rules.map((r) => <li key={r}>{r}</li>)}</ul>
          <Link className="btn btn-primary" href={`/login?next=${encodeURIComponent("/app/rewards")}`}>{t.fp.cta}</Link>
        </div>
      </section>
    </PublicPage>
  );
}
