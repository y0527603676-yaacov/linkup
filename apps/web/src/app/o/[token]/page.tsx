import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicPage } from "@/components/Site";
import { Alert } from "@/components/AppShell";
import { getT } from "@/i18n";
import { getMyOrgs } from "@/lib/orgs";
import { getSupabase } from "@/lib/supabase/server";
import { errorText, pct } from "@/lib/format";
import { acceptOffer } from "@/app/app/actions";

type Offer = {
  direction: "store_to_creator" | "creator_to_store"; from_name: string; invitee_name: string | null; target_site_url: string | null;
  commission_bps: number; coupon_discount_pct: number; attribution_days: number; platform_fee_bps: number; founders_months: number | null;
  status: "sent" | "opened" | "accepted" | "rejected" | "withdrawn" | "expired";
};

export default async function OfferPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { token } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f]{24}$/.test(token)) notFound();
  const { t, locale } = await getT();
  const p = t.proposal;
  const sb = await getSupabase();
  const { data } = await sb.rpc("get_public_proposal", { p_token: token });
  const offer = data as Offer | null;
  if (!offer) notFound();
  const { data: auth } = await sb.auth.getUser();
  const needType = offer.direction === "store_to_creator" ? "creator" : "store";
  const myOrgs = auth.user ? (await getMyOrgs()).filter((o) => o.type === needType && (o.role === "owner" || o.role === "admin")) : [];
  const open = offer.status === "sent" || offer.status === "opened";
  const toCreator = offer.direction === "store_to_creator";
  const rate = pct(offer.commission_bps, locale);
  return (
    <PublicPage path={`/o/${token}`}>
      <section className="container narrow" style={{ padding: "32px 16px 64px" }}>
        <p className="eyebrow">{p.eyebrow}</p>
        <h1>{toCreator ? p.toCreator(offer.from_name) : p.toStore(offer.from_name)}</h1>
        <Alert text={errorText(sp.error, t)} />
        <ul className="terms">
          {toCreator ? <><li>{p.c1(rate)}</li><li>{p.c2(offer.coupon_discount_pct)}</li><li>{p.c3(offer.attribution_days)}</li><li>{p.c4}</li></>
            : <><li>{p.s1(rate, offer.from_name)}</li><li>{p.s2(offer.coupon_discount_pct)}</li><li>{p.s3}</li><li>{p.s4(pct(offer.platform_fee_bps, locale), offer.founders_months)}</li></>}
        </ul>
        <p className="muted small">{p.base}</p>
        {!open ? <p className="alert alert-error">{offer.status === "expired" ? p.expired : p.handled}</p>
          : !auth.user ? <Link className="btn btn-primary btn-block" href={`/login?next=${encodeURIComponent(`/o/${token}`)}`}>{p.accept}</Link>
          : (
            <div className="stack">
              {myOrgs.map((o) => (
                <form key={o.id} action={acceptOffer}><input type="hidden" name="token" value={token} /><input type="hidden" name="org" value={o.id} />
                  <button className="btn btn-primary btn-block">{p.acceptAs(o.name)}</button></form>
              ))}
              <form action={acceptOffer} className="card stack">
                <input type="hidden" name="token" value={token} /><input type="hidden" name="type" value={needType} />
                <label className="field"><span>{myOrgs.length ? p.orNew : toCreator ? p.yourName : p.storeName}</span>
                  <input name="name" required minLength={2} maxLength={80} defaultValue={myOrgs.length ? "" : offer.invitee_name ?? ""} /></label>
                {!toCreator && !myOrgs.length && (
                  <label className="field"><span>{p.storeSite}</span><input name="website" dir="ltr" inputMode="url" defaultValue={offer.target_site_url ?? ""} placeholder="myshop.co.il" /></label>
                )}
                <button className={myOrgs.length ? "btn btn-ghost" : "btn btn-primary"}>{p.accept}</button>
              </form>
            </div>
          )}
      </section>
    </PublicPage>
  );
}
