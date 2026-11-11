import Link from "next/link";
import { PublicPage } from "@/components/Site";
import { FpBand } from "@/components/FpBand";
import { getT } from "@/i18n";

export default async function Home() {
  const { t } = await getT();
  const h = t.home;
  const storeCta = `/login?next=${encodeURIComponent("/app/new?type=store")}`;
  const creatorCta = `/login?next=${encodeURIComponent("/app/new?type=creator")}`;
  const icons = ["🛍️", "✨", "📊"];
  return (
    <PublicPage path="/">
      <section className="hero container">
        <h1>{h.title}</h1>
        <p className="lead">{h.lead}</p>
        <div className="actions">
          <Link className="btn btn-primary" href="/stores">{h.ctaStore}</Link>
          <Link className="btn btn-ghost" href="/creators">{h.ctaCreator}</Link>
        </div>
      </section>
      <section className="band alt">
        <div className="container">
          <h2>{h.benefitsTitle}</h2>
          <div className="features three">
            {h.cards.map((c, i) => (
              <div className="feature" key={c.t}><span className="ic" aria-hidden>{icons[i]}</span><h3>{c.t}</h3><p className="muted">{c.d}</p></div>
            ))}
          </div>
        </div>
      </section>
      <section className="band">
        <div className="container">
          <h2>{h.howTitle}</h2>
          <ol className="steps" style={{ marginTop: 20 }}>
            {h.how.map((s) => <li key={s.t}><h3>{s.t}</h3><p className="muted">{s.d}</p></li>)}
          </ol>
        </div>
      </section>
      <section className="band alt">
        <div className="container">
          <h2>{h.trustTitle}</h2>
          <ul className="trust-grid">{h.trust.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      </section>
      <FpBand t={t} />
      <section className="final container">
        <h2>{h.joinTitle}</h2>
        <p className="muted final-text">{h.joinText}</p>
        <div className="actions center-actions">
          <Link className="btn btn-primary" href={storeCta}>{h.joinStore}</Link>
          <Link className="btn btn-ghost" href={creatorCta}>{h.joinCreator}</Link>
        </div>
      </section>
    </PublicPage>
  );
}
