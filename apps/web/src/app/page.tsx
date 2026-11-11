import Link from "next/link";
import { PublicPage } from "@/components/Site";
import { FpBand } from "@/components/FpBand";
import { Icon } from "@/components/Icons";
import { HomeVisual } from "@/components/Mockups";
import { getT } from "@/i18n";

export default async function Home() {
  const { t, locale } = await getT();
  const h = t.home;
  const storeCta = `/login?next=${encodeURIComponent("/app/new?type=store")}`;
  const creatorCta = `/login?next=${encodeURIComponent("/app/new?type=creator")}`;
  const cardIcons = [["store", "t-brand"], ["sparkles", "t-accent"], ["chart", "t-money"]] as const;
  const howIcons = ["store", "share", "bag"] as const;
  const trustIcons = ["receipt", "refresh", "lock", "shield"] as const;
  return (
    <PublicPage path="/">
      <section className="hero hero-split container">
        <div className="hero-copy">
          <h1>{h.title}</h1>
          <p className="lead">{h.lead}</p>
          <div className="actions">
            <Link className="btn btn-primary btn-lg" href="/stores">{h.ctaStore}</Link>
            <Link className="btn btn-ghost btn-lg" href="/creators">{h.ctaCreator}</Link>
          </div>
        </div>
        <HomeVisual t={t} locale={locale} />
      </section>
      <section className="band alt">
        <div className="container">
          <h2>{h.benefitsTitle}</h2>
          <div className="features three">
            {h.cards.map((c, i) => (
              <div className={`feature ${cardIcons[i]![1]}`} key={c.t}>
                <span className={`tile ${cardIcons[i]![1]}`}><Icon name={cardIcons[i]![0]} /></span>
                <h3>{c.t}</h3><p className="muted">{c.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="band">
        <div className="container">
          <h2>{h.howTitle}</h2>
          <ol className="flow">
            {h.how.map((s, i) => (
              <li key={s.t}>
                <span className="flow-node"><Icon name={howIcons[i]!} size={26} /><b className="flow-n">{i + 1}</b></span>
                <h3>{s.t}</h3><p className="muted">{s.d}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>
      <section className="band alt">
        <div className="container">
          <h2>{h.trustTitle}</h2>
          <ul className="trust-grid">{h.trust.map((x, i) => <li key={x}><span className="tile sm t-money"><Icon name={trustIcons[i]!} size={18} /></span><span>{x}</span></li>)}</ul>
        </div>
      </section>
      <FpBand t={t} />
      <section className="final container">
        <h2>{h.joinTitle}</h2>
        <p className="muted final-text">{h.joinText}</p>
        <div className="actions center-actions">
          <Link className="btn btn-primary btn-lg" href={storeCta}>{h.joinStore}</Link>
          <Link className="btn btn-ghost btn-lg" href={creatorCta}>{h.joinCreator}</Link>
        </div>
      </section>
    </PublicPage>
  );
}
