import Link from "next/link";
import type { Dict } from "@/i18n/he";

/** FOUNDING PARTNERS band for the marketing pages – only the approved program texts, terms linked in full. */
export function FpBand({ t }: { t: Dict }) {
  const r = t.rewards;
  return (
    <section className="band">
      <div className="container">
        <div className="fp fp-band">
          <div className="fp-copy">
            <p className="eyebrow fp-eyebrow">{t.fp.title}</p>
            <h2>{r.title}</h2>
            <p>{r.lead}</p>
          </div>
          <div className="fp-offer">
            <b className="fp-big">{r.benefitTitle}</b>
            <p>{r.benefitText}</p>
            <p className="small fp-note">{r.splitNote}</p>
            <div className="fp-actions">
              <Link className="btn btn-primary" href={`/login?next=${encodeURIComponent("/app/rewards")}`}>{t.fp.cta}</Link>
              <Link className="btn btn-ghost fp-ghost" href="/founding-partners">{t.home.fpCta}</Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
