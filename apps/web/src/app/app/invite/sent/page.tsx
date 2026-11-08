import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { CopyButton } from "@/components/CopyButton";
import { getMyOrgs, pickOrg } from "@/lib/orgs";
import { getOrigin } from "@/lib/supabase/server";

type SP = Promise<Record<string, string | undefined>>;

export default async function Sent({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const orgs = await getMyOrgs();
  const org = pickOrg(orgs, sp.org);
  if (!org || !sp.token || !/^[0-9a-f]{24}$/.test(sp.token)) redirect("/app");
  const link = `${await getOrigin()}/o/${sp.token}`;
  const hi = sp.name ? `היי ${sp.name}, ` : "היי, ";
  const text = org.type === "store"
    ? `${hi}רצינו להציע לך שיתוף פעולה עם ${org.name}: עמלה על כל מכירה שתביא/י + קופון הנחה לעוקבים שלך. כל הפרטים ואישור בלחיצה:\n${link}`
    : `${hi}אשמח לקדם את החנות שלכם. תשלמו עמלה רק על מכירות שאביא בפועל, הכל נמדד אוטומטית. פרטים ואישור:\n${link}`;

  return (
    <Shell org={org} orgs={orgs}>
      <div className="narrow">
        <h1>הקישור מוכן 🎉</h1>
        <p>שלחו אותו עכשיו — הצעות שנשלחות מיד מתקבלות הרבה יותר.</p>
        <a className="btn btn-whatsapp" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener">שליחה בוואטסאפ</a>
        <div className="keybox" dir="ltr">{link}</div>
        <div className="actions">
          <CopyButton text={link} label="העתקת קישור" />
          <CopyButton text={text} label="העתקת הודעה מלאה" />
        </div>
        <hr />
        <div className="actions">
          <Link className="btn btn-ghost" href={`/app/invite?org=${org.id}`}>הזמנה נוספת</Link>
          <Link className="btn btn-ghost" href={`/app?org=${org.id}`}>למסך הבית</Link>
        </div>
      </div>
    </Shell>
  );
}
