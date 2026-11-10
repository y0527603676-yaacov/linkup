"use client";
import { useEffect, useState } from "react";

type Copy = { codeHint: string; code: string; verify: string };

/**
 * The sign-in link stays the default. The code field appears only where the link cannot finish the sign-in:
 * inside an app installed on an iPhone/iPad home screen (it does not share Safari's cookies), or after a link was
 * opened in a different browser. The form posts to the existing server action; nothing is stored in the page.
 */
export function CodeEntry({ email, next, copy, forced, action }: {
  email: string; next: string; copy: Copy; forced: boolean; action: (form: FormData) => void | Promise<void>;
}) {
  const [show, setShow] = useState(forced);
  useEffect(() => {
    // Only an installed iPhone/iPad app needs it (Android home-screen apps share Chrome's sign-in).
    if ((navigator as { standalone?: boolean }).standalone === true) setShow(true);
  }, []);
  if (!show) return null;
  return (
    <form action={action} className="stack">
      <p className="small muted" style={{ margin: 0 }}>{copy.codeHint}</p>
      <input type="hidden" name="email" value={email} /><input type="hidden" name="next" value={next} />
      <label className="field"><span>{copy.code}</span>
        <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,12}" required dir="ltr" /></label>
      <button className="btn btn-primary btn-block">{copy.verify}</button>
    </form>
  );
}
