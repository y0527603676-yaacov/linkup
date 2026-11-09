import type { Metadata } from "next";
import Link from "next/link";
import { Faq, PublicPage } from "@/components/Site";
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
        <p className="eyebrow">{s.eyebrow}</p>
        <h1>{s.title}</h1>
        <p className="lead">{s.lead}</p>
        <div className="actions">
          <Link className="btn btn-primary" href={cta}>{s.cta}</Link>
          <a className="btn btn-ghost" href="#how">{t.common.learnMore}</a>
        </div>
        <p className="note">{s.note}</p>
      </section>
      <section className="band alt" id="how">
        <div className="container">
          <h2>{s.stepsTitle}</h2>
          <ol className="steps" style={{ marginTop: 20 }}>{s.steps.map((x) => <li key={x.t}><h3>{x.t}</h3><p className="muted">{x.d}</p></li>)}</ol>
        </div>
      </section>
      <section className="band">
        <div className="container">
          <h2>{s.priceTitle}</h2>
          <p className="sub">{s.priceLead}</p>
          <PriceCalc l={s.calc} locale={locale} />
        </div>
      </section>
      <section className="band alt">
        <div className="container">
          <h2>{s.measureTitle}</h2>
          <ol className="steps" style={{ marginTop: 20 }}>{s.measure.map((x) => <li key={x.t}><h3>{x.t}</h3><p className="muted">{x.d}</p></li>)}</ol>
        </div>
      </section>
      <section className="band">
        <div className="container split">
          <div className="card">
            <p className="eyebrow">{s.launchTitle}</p>
            <h2 style={{ marginTop: 8 }}>{s.launchTitle}</h2>
            <p className="muted">{s.launchText}</p>
          </div>
          <div className="fp">
            <h2>{t.fp.title}</h2>
            <p>{t.fp.lead}</p>
            <Link className="btn btn-primary" href="/founding-partners">{t.home.fpCta}</Link>
          </div>
        </div>
      </section>
      <section className="band alt">
        <div className="container" style={{ maxWidth: 760 }}>
          <h2>{s.faqTitle}</h2>
          <Faq items={s.faq} />
        </div>
      </section>
      <section className="final container">
        <h2>{s.finalTitle}</h2>
        <Link className="btn btn-primary" href={cta}>{s.cta}</Link>
      </section>
    </PublicPage>
  );
}
