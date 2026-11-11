import type { Metadata } from "next";
import Link from "next/link";
import { PublicPage, Faq } from "@/components/Site";
import { FpBand } from "@/components/FpBand";
import { Icon } from "@/components/Icons";
import { StoreDashVisual, LaunchVisual } from "@/components/Mockups";
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
      <section className="hero hero-split container">
        <div className="hero-copy">
          <h1>{s.title}</h1>
          <p className="lead">{s.lead}</p>
          <div className="actions"><Link className="btn btn-primary btn-lg" href={cta}>{s.cta}</Link></div>
          <p className="note">{s.note}</p>
        </div>
        <StoreDashVisual t={t} locale={locale} />
      </section>
      <section className="band alt">
        <div className="container">
          <h2>{s.benefitsTitle}</h2>
          <div className="features four">
            {s.benefits.map((b, i) => (
              <div className={`feature ${i === 0 ? "feature-hl" : ""}`} key={b.t}>
                <span className={`tile ${["t-brand", "t-accent", "t-money", "t-brand"][i]}`}><Icon name={["target", "sliders", "chart", "users"][i]!} /></span>
                <h3>{b.t}</h3><p className="muted">{b.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="band">
        <div className="container">
          <h2>{s.calcTitle}</h2>
          <p className="sub">{s.calcLead}</p>
          <PriceCalc l={s.calc} locale={locale} />
          <div className="card price-card">
            <h3>{s.priceTitle}</h3>
            <b className="price-big">{s.priceBig}</b>
            <p>{s.priceText}</p>
            <p className="small muted">{s.priceExplain}</p>
            <p className="price-note">{s.priceNote}</p>
            <div><Link className="btn btn-primary" href={cta}>{s.priceCta}</Link></div>
          </div>
        </div>
      </section>
      <section className="band alt">
        <div className="container">
          <div className="launch">
            <div className="launch-copy">
              <span className="tile t-accent lg"><Icon name="rocket" size={28} /></span>
              <h2>{s.launchTitle}</h2>
              <p>{s.launchText}</p>
            </div>
            <LaunchVisual t={t} />
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
