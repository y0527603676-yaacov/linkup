import type { Metadata } from "next";
import Link from "next/link";
import { PublicPage, Faq } from "@/components/Site";
import { FpBand } from "@/components/FpBand";
import { PriceCalc } from "@/components/PriceCalc";
import { getT } from "@/i18n";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t.common.stores, description: t.stores.lead };
}

export default async function Stores() {
  const { t, locale } = await getT();
  const s = t.stores;
  const cta = `/login?next=${encodeURIComponent("/app/new?type=store")}`;
  return (
    <PublicPage path="/stores">
      <section className="hero container">
        <h1>{s.title}</h1>
        <p className="lead">{s.lead}</p>
        <div className="actions"><Link className="btn btn-primary" href={cta}>{s.cta}</Link></div>
        <p className="note">{s.note}</p>
      </section>
      <section className="band alt">
        <div className="container">
          <h2>{s.benefitsTitle}</h2>
          <div className="features four">
            {s.benefits.map((b) => <div className="feature" key={b.t}><h3>{b.t}</h3><p className="muted">{b.d}</p></div>)}
          </div>
        </div>
      </section>
      <section className="band">
        <div className="container">
          <h2>{s.calcTitle}</h2>
          <p className="sub">{s.calcLead}</p>
          <PriceCalc l={s.calc} locale={locale} />
        </div>
      </section>
      <section className="band alt">
        <div className="container">
          <div className="card launch-card">
            <p className="eyebrow">{s.launchTitle}</p>
            <p style={{ margin: "8px 0 0", fontSize: "1.08rem" }}>{s.launchText}</p>
          </div>
        </div>
      </section>
      <FpBand t={t} />
      <section className="band alt">
        <div className="container" style={{ maxWidth: 760 }}>
          <h2>{s.faqTitle}</h2>
          <Faq items={s.faq} />
        </div>
      </section>
      <section className="final container">
        <h2>{s.finalTitle}</h2>
        <p className="muted final-text">{s.finalText}</p>
        <Link className="btn btn-primary" href={cta}>{s.finalCta}</Link>
      </section>
    </PublicPage>
  );
}
