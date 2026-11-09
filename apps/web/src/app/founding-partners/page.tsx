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
          <h1 style={{ letterSpacing: ".06em" }}>{t.fp.title}</h1>
          <p className="lead" style={{ color: "rgb(255 255 255 / .9)" }}>{t.fp.lead}</p>
          <ul className="ticks" style={{ margin: "20px 0" }}>{t.fp.rules.map((r) => <li key={r}>{r}</li>)}</ul>
          <Link className="btn btn-primary" href={`/login?next=${encodeURIComponent("/app/rewards")}`}>{t.fp.cta}</Link>
        </div>
      </section>
    </PublicPage>
  );
}
