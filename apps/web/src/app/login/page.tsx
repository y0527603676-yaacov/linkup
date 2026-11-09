import Link from "next/link";
import { Logo } from "@/components/Site";
import { Alert } from "@/components/AppShell";
import { getT } from "@/i18n";
import { errorText, safeNext } from "@/lib/format";
import { sendLink, verifyCode } from "./actions";

export default async function Login({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { t, locale } = await getT();
  const l = t.login;
  const next = safeNext(sp.next);
  return (
    <div className="auth-wrap">
      <div className="card stack">
        <div className="row between"><Logo /><a className="small" href={`/lang?to=${locale === "he" ? "en" : "he"}&next=${encodeURIComponent(`/login?next=${encodeURIComponent(next)}`)}`}>{t.common.langSwitch}</a></div>
        {sp.sent && sp.email ? (
          <>
            <h1>{l.sentTitle}</h1>
            <p className="muted">{l.sentText(sp.email)}</p>
            <Alert text={errorText(sp.error, t)} />
            <form action={verifyCode} className="stack">
              <input type="hidden" name="email" value={sp.email} /><input type="hidden" name="next" value={next} />
              <label className="field"><span>{l.code}</span>
                <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,10}" required dir="ltr" autoFocus /></label>
              <button className="btn btn-primary btn-block">{l.verify}</button>
            </form>
            <Link className="small center" href={`/login?next=${encodeURIComponent(next)}`}>{l.other}</Link>
          </>
        ) : (
          <>
            <h1>{l.title}</h1>
            <p className="muted">{l.lead}</p>
            <Alert text={errorText(sp.error, t)} />
            <form action={sendLink} className="stack">
              <input type="hidden" name="next" value={next} />
              <label className="field"><span>{l.email}</span>
                <input name="email" type="email" autoComplete="email" required dir="ltr" autoFocus /></label>
              <button className="btn btn-primary btn-block">{l.send}</button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
