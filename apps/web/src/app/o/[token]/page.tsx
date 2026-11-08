import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, Shell } from "@/components/Shell";
import { getMyOrgs } from "@/lib/orgs";
import { getSupabase } from "@/lib/supabase/server";
import { errorText, pct } from "@/lib/format";
import { acceptOffer } from "@/app/app/actions";

type Offer = {
  direction: "store_to_creator" | "creator_to_store";
  from_name: string; from_website: string | null; invitee_name: string | null; target_site_url: string | null;
  commission_bps: number; coupon_discount_pct: number; attribution_days: number;
  platform_fee_bps: number; founders_months: number | null;
  status: "sent" | "opened" | "accepted" | "rejected" | "withdrawn" | "expired";
};

export default async function OfferPage({ params, searchParams }: {
  params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f]{24}$/.test(token)) notFound();
  const sb = await getSupabase();
  const { data } = await sb.rpc("get_public_proposal", { p_token: token });
  const offer = data as Offer | null;
  if (!offer) notFound();

  const { data: auth } = await sb.auth.getUser();
  const needType = offer.direction === "store_to_creator" ? "creator" : "store";
  const myOrgs = auth.user ? (await getMyOrgs()).filter((o) => o.type === needType) : [];
  const open = offer.status === "sent" || offer.status === "opened";
  const toCreator = offer.direction === "store_to_creator";

  return (
    <Shell>
      <div className="narrow">
        <p className="eyebrow">הצעת שיתוף פעולה{offer.invitee_name ? ` ל${offer.invitee_name}` : ""}</p>
        <h1>{toCreator ? `${offer.from_name} מזמינה אותך לשיתוף פעולה` : `${offer.from_name} רוצה לקדם את החנות שלך`}</h1>
        <Alert text={errorText(sp.error)} />

        <ul className="terms">
          {toCreator ? (
            <>
              <li><b>{pct(offer.commission_bps)}</b> עמלה מכל מכירה שתביא/י</li>
              <li><b>{offer.coupon_discount_pct}%</b> הנחה לעוקבים שלך עם קופון אישי</li>
              <li>מכירה נספרת עם הקופון, או עד <b>{offer.attribution_days} יום</b> מקליק על הקישור שלך</li>
              <li>רואים כל מכירה ועמלה בזמן אמת. התשלום ישירות מהחנות.</li>
            </>
          ) : (
            <>
              <li>משלמים <b>{pct(offer.commission_bps)}</b> רק על מכירות שהגיעו דרך {offer.from_name}</li>
              <li><b>{offer.coupon_discount_pct}%</b> הנחה ללקוחות שמגיעים עם הקופון</li>
              <li>הכל נמדד אוטומטית מ-WooCommerce, כולל החזרות וביטולים</li>
              <li>עמלת LINKUP: {pct(offer.platform_fee_bps)} מהמכירות המיוחסות בלבד{offer.founders_months ? ` (מחיר מייסדים ל-${offer.founders_months} חודשים)` : ""}. בלי מנוי.</li>
            </>
          )}
        </ul>
        <p className="muted small">העמלה מחושבת על סכום המכירה בלי מע״מ ומשלוח. החזרות וביטולים מקטינים את העמלה בהתאם.</p>

        {!open ? (
          <p className="alert alert-error">{offer.status === "expired" ? "תוקף ההצעה פג." : "ההצעה הזו כבר טופלה."}</p>
        ) : !auth.user ? (
          <Link className="btn btn-primary" href={`/login?next=${encodeURIComponent(`/o/${token}`)}`}>אישור ההצעה</Link>
        ) : (
          <div className="stack">
            {myOrgs.map((o) => (
              <form key={o.id} action={acceptOffer}>
                <input type="hidden" name="token" value={token} />
                <input type="hidden" name="org" value={o.id} />
                <button className="btn btn-primary">אישור כ{o.name}</button>
              </form>
            ))}
            <form action={acceptOffer} className={myOrgs.length ? "stack subtle" : "stack"}>
              <input type="hidden" name="token" value={token} />
              <input type="hidden" name="type" value={needType} />
              <label className="field">
                <span>{myOrgs.length ? "או חשבון חדש בשם" : toCreator ? "השם שלך (כפי שיופיע לחנות)" : "שם החנות"}</span>
                <input name="name" required minLength={2} maxLength={80} defaultValue={myOrgs.length ? "" : offer.invitee_name ?? ""} />
              </label>
              {!toCreator && !myOrgs.length && (
                <label className="field">
                  <span>אתר החנות</span>
                  <input name="website" dir="ltr" inputMode="url" defaultValue={offer.target_site_url ?? ""} placeholder="myshop.co.il" />
                </label>
              )}
              <button className={myOrgs.length ? "btn btn-ghost" : "btn btn-primary"}>אישור ההצעה</button>
            </form>
          </div>
        )}
        <p className="muted small center">LINKUP · שיתופי פעולה שמשלמים רק על תוצאות</p>
      </div>
    </Shell>
  );
}
