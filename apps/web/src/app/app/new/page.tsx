import { Alert, Shell } from "@/components/Shell";
import { errorText } from "@/lib/format";
import { createOrg } from "../actions";

type SP = Promise<Record<string, string | undefined>>;

export default async function NewOrg({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const type = sp.type ?? "store";
  return (
    <Shell>
      <div className="narrow">
        <h1>מי אתם?</h1>
        <Alert text={errorText(sp.error)} />
        <form action={createOrg} className="stack">
          <input type="hidden" name="next" value={sp.next ?? ""} />
          <fieldset className="choices">
            <label><input type="radio" name="type" value="store" defaultChecked={type === "store"} /><span><strong>חנות אונליין</strong><small>רוצה משפיענים שמביאים מכירות</small></span></label>
            <label><input type="radio" name="type" value="creator" defaultChecked={type === "creator"} /><span><strong>משפיען/ית</strong><small>רוצה להרוויח מקידום חנויות</small></span></label>
            <label><input type="radio" name="type" value="agency" defaultChecked={type === "agency"} /><span><strong>סוכנות</strong><small>מנהלת משפיענים</small></span></label>
          </fieldset>
          <label className="field">
            <span>שם (החנות / שלך / הסוכנות)</span>
            <input name="name" required minLength={2} maxLength={80} />
          </label>
          <button className="btn btn-primary">המשך</button>
        </form>
      </div>
    </Shell>
  );
}
