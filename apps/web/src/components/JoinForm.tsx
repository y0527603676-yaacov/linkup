"use client";
import { useState } from "react";
import { LegalChecks, type PendingDoc } from "./LegalChecks";

type Copy = {
  store: { t: string; d: string }; creator: { t: string; d: string };
  storeName: string; creatorName: string; website: string; create: string; legalLabel: string;
};

/** Store / creator choice switches instantly on the client (no server round trip); the server action is unchanged. */
export function JoinForm({ initial, next, copy, locale, signupDocs, creatorDocs, action }: {
  initial: "store" | "creator" | null; next: string; copy: Copy; locale: string;
  signupDocs: PendingDoc[]; creatorDocs: PendingDoc[]; action: (form: FormData) => void | Promise<void>;
}) {
  const [type, setType] = useState(initial);
  const pick = (v: "store" | "creator") => {
    setType(v);
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("type", v);
      window.history.replaceState(window.history.state, "", u);
    } catch { /* address bar is cosmetic only */ }
  };
  const docs = type === "creator" ? [...signupDocs, ...creatorDocs.filter((d) => !signupDocs.some((s) => s.doc_key === d.doc_key))] : signupDocs;
  return (
    <>
      <div className="pill-toggle" role="tablist">
        <button type="button" role="tab" aria-selected={type === "store"} className={type === "store" ? "on" : ""} onClick={() => pick("store")}>{copy.store.t}</button>
        <button type="button" role="tab" aria-selected={type === "creator"} className={type === "creator" ? "on" : ""} onClick={() => pick("creator")}>{copy.creator.t}</button>
      </div>
      {type ? (
        <form action={action} className="stack">
          <p className="muted small">{type === "store" ? copy.store.d : copy.creator.d}</p>
          <input type="hidden" name="type" value={type} />
          <input type="hidden" name="next" value={next} />
          <label className="field"><span>{type === "store" ? copy.storeName : copy.creatorName}</span>
            <input name="name" required minLength={2} maxLength={80} autoFocus /></label>
          {type === "store" && (
            <label className="field"><span>{copy.website}</span>
              <input name="website" dir="ltr" inputMode="url" placeholder="myshop.co.il" /></label>
          )}
          <LegalChecks docs={docs} locale={locale} label={copy.legalLabel} />
          <button className="btn btn-primary btn-block">{copy.create}</button>
        </form>
      ) : null}
    </>
  );
}
