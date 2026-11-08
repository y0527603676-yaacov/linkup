"use client";
import { useActionState } from "react";
import { connectStore, type ConnectState } from "../actions";
import { CopyButton } from "@/components/CopyButton";

const ERR: Record<string, string> = {
  invalid_url: "כתובת האתר לא תקינה. לדוגמה: myshop.co.il",
  forbidden: "רק מנהל/ת החנות יכול/ה לחבר אתר.",
};

export function ConnectForm({ orgId }: { orgId: string }) {
  const [state, action, pending] = useActionState<ConnectState, FormData>(connectStore, {});

  if (state.key && state.site) {
    return (
      <ol className="steps">
        <li>
          <strong>מפתח החיבור שלכם</strong> — מוצג פעם אחת בלבד. העתיקו אותו עכשיו.
          <div className="keybox" dir="ltr">{state.key}</div>
          <CopyButton text={state.key} label="העתקת המפתח" />
        </li>
        <li>
          <strong>התקינו את התוסף</strong>
          <p><a className="btn btn-ghost btn-sm" href="/downloads/linkup-connector.zip" download>הורדת התוסף</a></p>
          <p>ואז: <a href={`${state.site}/wp-admin/plugin-install.php?tab=upload`} target="_blank" rel="noopener">העלאת תוסף בוורדפרס ↗</a> ← בחירת הקובץ ← "התקן עכשיו" ← "הפעל".</p>
        </li>
        <li>
          <strong>הדביקו את המפתח</strong>
          <p><a href={`${state.site}/wp-admin/admin.php?page=linkup`} target="_blank" rel="noopener">WooCommerce ← LINKUP ↗</a> ← הדבקה ← "שמירה וחיבור".</p>
        </li>
        <li>
          <a className="btn btn-primary" href={`/app?org=${orgId}`}>סיימתי — למסך הבית</a>
        </li>
      </ol>
    );
  }

  return (
    <form action={action} className="stack">
      <input type="hidden" name="org" value={orgId} />
      {state.error && <p className="alert alert-error">{ERR[state.error] ?? "משהו השתבש. נסו שוב."}</p>}
      <label className="field">
        <span>כתובת החנות</span>
        <input name="site" required dir="ltr" inputMode="url" placeholder="myshop.co.il" />
      </label>
      <button className="btn btn-primary" disabled={pending}>{pending ? "רגע…" : "יצירת מפתח חיבור"}</button>
    </form>
  );
}
