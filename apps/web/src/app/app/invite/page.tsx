import { redirect } from "next/navigation";
import { Alert, Shell } from "@/components/Shell";
import { getMyOrgs, pickOrg } from "@/lib/orgs";
import { getSupabase } from "@/lib/supabase/server";
import { errorText } from "@/lib/format";
import { createInvite } from "../actions";

type SP = Promise<Record<string, string | undefined>>;

export default async function Invite({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const orgs = await getMyOrgs();
  const org = pickOrg(orgs, sp.org);
  if (!org) redirect("/app/new");
  if (org.type === "agency") redirect(`/app?org=${org.id}`);

  const sb = await getSupabase();
  const { data: o } = await sb.from("organizations").select("default_commission_bps").eq("id", org.id).single();
  const defaultPct = ((o?.default_commission_bps as number | undefined) ?? 1000) / 100;
  const isStore = org.type === "store";

  return (
    <Shell org={org} orgs={orgs}>
      <div className="narrow">
        <h1>{isStore ? "הזמנת משפיען/ית" : "הזמנת חנות"}</h1>
        <p className="muted">
          {isStore
            ? "נוצר קישור להצעה. שולחים אותו בוואטסאפ, והמשפיען/ית מאשר/ת בלחיצה."
            : "נוצרת הצעה מוכנה לחנות: אתם מקדמים, והם משלמים רק על מכירות שהבאתם."}
        </p>
        <Alert text={errorText(sp.error)} />
        <form action={createInvite} className="stack">
          <input type="hidden" name="org" value={org.id} />
          <label className="field">
            <span>{isStore ? "שם המשפיען/ית" : "שם החנות"} <small className="muted">(לא חובה)</small></span>
            <input name="name" maxLength={120} />
          </label>
          {!isStore && (
            <label className="field">
              <span>אתר החנות <small className="muted">(לא חובה)</small></span>
              <input name="site" dir="ltr" inputMode="url" placeholder="theirshop.co.il" />
            </label>
          )}
          <div className="row2">
            <label className="field">
              <span>עמלה מכל מכירה</span>
              <div className="suffix"><input name="commission" type="number" min={1} max={50} step={0.5} defaultValue={defaultPct} required /><b>%</b></div>
            </label>
            <label className="field">
              <span>הנחה ללקוחות</span>
              <div className="suffix"><input name="discount" type="number" min={0} max={50} step={1} defaultValue={10} required /><b>%</b></div>
            </label>
          </div>
          <p className="muted small">העמלה מחושבת על סכום המכירה בלי מע״מ ומשלוח. ייחוס: קופון אישי או קליק על הקישור עד 30 יום.</p>
          <button className="btn btn-primary">יצירת קישור הזמנה</button>
        </form>
      </div>
    </Shell>
  );
}
