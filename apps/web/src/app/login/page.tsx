import { withBrand } from "@/components/Brand";
import Link from "next/link";
import { Logo } from "@/components/Site";
import { Alert } from "@/components/AppShell";
import { getT } from "@/i18n";
import { errorText, safeNext } from "@/lib/format";
import { sendLink, verifyCode } from "./actions";
import { LOGIN_EMAIL_HAS_CODE } from "@/lib/auth-config";
import { CodeEntry } from "@/components/CodeEntry";

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
            {LOGIN_EMAIL_HAS_CODE && (
              <CodeEntry email={sp.email} next={next} action={verifyCode} forced={sp.error === "bad_code" || sp.error === "link_other_browser"}
                copy={{ codeHint: l.codeHint, code: l.code, verify: l.verify }} />
            )}
            {sp.resent && !sp.error && <p className="badge badge-brand">{l.resent}</p>}
            <p className="small muted">{l.spam}</p>
            <form action={sendLink} className="stack">
              <input type="hidden" name="email" value={sp.email} /><input type="hidden" name="next" value={next} /><input type="hidden" name="resend" value="1" />
              <button className="btn btn-ghost btn-block">{l.resend}</button>
            </form>
            <Link className="small center" href={`/login?next=${encodeURIComponent(next)}`}>{l.other}</Link>
          </>
        ) : (
          <>
            <h1>{withBrand(l.title)}</h1>
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
