import { Alert, Shell } from "@/components/Shell";
import { errorText, safeNext } from "@/lib/format";
import { sendLink, verifyCode } from "./actions";

type SP = Promise<Record<string, string | undefined>>;

export default async function Login({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const sent = sp.sent === "1" && sp.email;

  return (
    <Shell>
      <div className="narrow">
        <h1>{sent ? "בדקו את המייל" : "כניסה ל-LINKUP"}</h1>
        <Alert text={errorText(sp.error)} />
        {!sent ? (
          <>
            <p className="muted">בלי סיסמה. נשלח אליכם קישור כניסה במייל.</p>
            <form action={sendLink} className="stack">
              <input type="hidden" name="next" value={next} />
              <label className="field">
                <span>מייל</span>
                <input name="email" type="email" required autoComplete="email" inputMode="email" dir="ltr" placeholder="you@example.com" />
              </label>
              <button className="btn btn-primary">שלחו לי קישור</button>
            </form>
          </>
        ) : (
          <>
            <p>שלחנו קישור כניסה אל <bdi dir="ltr">{sp.email}</bdi>. לחצו עליו מהמכשיר הזה.</p>
            <p className="muted">קיבלתם קוד ספרות במקום? הקלידו אותו כאן:</p>
            <form action={verifyCode} className="stack">
              <input type="hidden" name="next" value={next} />
              <input type="hidden" name="email" value={sp.email} />
              <label className="field">
                <span>קוד מהמייל</span>
                <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,10}" required dir="ltr" />
              </label>
              <button className="btn btn-primary">כניסה</button>
            </form>
            <p><a href={`/login?next=${encodeURIComponent(next)}`}>שליחה למייל אחר</a></p>
          </>
        )}
      </div>
    </Shell>
  );
}
