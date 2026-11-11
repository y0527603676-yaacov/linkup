import type { Metadata } from "next";
import Link from "next/link";
import { PublicPage } from "@/components/Site";
import { getT } from "@/i18n";
import { getSupabase } from "@/lib/supabase/server";
import { money, pct } from "@/lib/format";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t.common.creators, description: t.creators.lead };
}

type Preview = { kind: string; commission_bps: number; coupon_discount_pct: number; store_name: string; product_name: string; image_url: string; price_minor: number; currency: string };

export default async function Creators() {
  const { t, locale } = await getT();
  const c = t.creators;
  const sb = await getSupabase();
  const { data } = await sb.rpc("public_catalog_preview");
  const items = (data as Preview[] | null) ?? [];
  const cta = `/login?next=${encodeURIComponent("/app/new?type=creator")}`;
  return (
    <PublicPage path="/creators">
      <section className="hero container">
        <h1>{c.title}</h1>
        <p className="lead">{c.lead}</p>
        <div className="actions"><Link className="btn btn-primary" href={cta}>{c.cta}</Link></div>
        <p className="note">{c.note}</p>
      </section>
      <section className="band alt">
        <div className="container">
          <h2>{c.benefitsTitle}</h2>
          <div className="features four">
            {c.benefits.map((b) => <div className="feature" key={b.t}><h3>{b.t}</h3><p className="muted">{b.d}</p></div>)}
          </div>
        </div>
      </section>
      <section className="band">
        <div className="container">
          <h2>{c.stepsTitle}</h2>
          <ol className="steps" style={{ marginTop: 20 }}>{c.steps.map((x) => <li key={x}><h3>{x}</h3></li>)}</ol>
        </div>
      </section>
      {/* Live opportunities: real data only, shown when there are any */}
      {items.length > 0 && (
        <section className="band alt">
          <div className="container">
            <h2>{c.nowTitle}</h2>
            <div className="opps" style={{ marginTop: 16 }}>
              {items.map((o, i) => (
                <div className="opp" key={i}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className="img" src={o.image_url} alt={o.product_name} loading="lazy" />
                  <div className="body">
                    <div className="row between"><b>{o.store_name}</b>{o.kind === "campaign" && <span className="badge badge-accent">LAUNCH</span>}</div>
                    <span className="muted small">{o.product_name} · {money(o.price_minor, o.currency, locale)}</span>
                    <div className="row"><span className="badge badge-money">{c.commission} {pct(o.commission_bps, locale)}</span><span className="badge">{c.discount} {o.coupon_discount_pct}%</span></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
      <section className="final container">
        <h2>{c.finalTitle}</h2>
        <Link className="btn btn-primary" href={cta}>{c.finalCta}</Link>
      </section>
    </PublicPage>
  );
}
