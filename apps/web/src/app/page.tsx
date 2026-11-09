import Link from "next/link";
import { PublicPage } from "@/components/Site";
import { getT } from "@/i18n";

export default async function Home() {
  const { t, dir } = await getT();
  const h = t.home;
  const arrow = dir === "rtl" ? "←" : "→";
  return (
    <PublicPage path="/">
      <section className="hero container">
        <p className="eyebrow">{h.eyebrow}</p>
        <h1>{h.title}</h1>
        <p className="lead">{h.lead}</p>
        <div className="split" style={{ marginTop: 28 }}>
          <Link href="/stores" className="choice store">
            <span className="ic" aria-hidden>🛍️</span>
            <h2>{h.storeCard.title}</h2>
            <p className="muted">{h.storeCard.text}</p>
            <div className="go">{h.storeCard.cta} {arrow}</div>
          </Link>
          <Link href="/creators" className="choice creator">
            <span className="ic" aria-hidden>✨</span>
            <h2>{h.creatorCard.title}</h2>
            <p className="muted">{h.creatorCard.text}</p>
            <div className="go">{h.creatorCard.cta} {arrow}</div>
          </Link>
        </div>
      </section>
      <section className="band alt">
        <div className="container">
          <h2>{h.howTitle}</h2>
          <ol className="steps" style={{ marginTop: 20 }}>
            {h.how.map((s) => <li key={s.t}><h3>{s.t}</h3><p className="muted">{s.d}</p></li>)}
          </ol>
        </div>
      </section>
      <section className="band">
        <div className="container split">
          <div>
            <h2>{h.trustTitle}</h2>
            <p className="sub">{t.slogan}.</p>
            <ul className="ticks">{h.trust.map((x) => <li key={x}>{x}</li>)}</ul>
          </div>
          <div className="fp">
            <h2>{h.fpTitle}</h2>
            <p>{h.fpText}</p>
            <Link className="btn btn-primary" href="/founding-partners" style={{ marginTop: 12 }}>{h.fpCta}</Link>
          </div>
        </div>
      </section>
    </PublicPage>
  );
}
