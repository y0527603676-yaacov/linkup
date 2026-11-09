"use client";
import { useActionState } from "react";
import { connectStore, type ConnectState } from "../actions";
import { CopyButton } from "@/components/CopyButton";
import type { Dict } from "@/i18n/he";

export function ConnectForm({ orgId, l, errors, defaultSite, rotate }: {
  orgId: string; l: Dict["connect"]; errors: Record<string, string>; defaultSite: string; rotate: boolean;
}) {
  const [state, action, pending] = useActionState<ConnectState, FormData>(connectStore, {});
  if (state.key && state.site) {
    return (
      <ol className="steps" style={{ gridTemplateColumns: "1fr" }}>
        <li>
          <h3>{l.keyTitle}</h3><p className="muted small">{l.keyNote}</p>
          <div className="keybox" dir="ltr">{state.key}</div>
          <CopyButton text={state.key} label={l.copyKey} />
        </li>
        <li>
          <h3>{l.install}</h3>
          <p><a className="btn btn-ghost btn-sm" href="/downloads/linkup-connector.zip" download>{l.download}</a></p>
          <p className="small">{l.installHow} <a href={`${state.site}/wp-admin/plugin-install.php?tab=upload`} target="_blank" rel="noopener">{l.uploadLink}</a></p>
        </li>
        <li>
          <h3>{l.paste}</h3>
          <p className="small">{l.pasteHow} <a href={`${state.site}/wp-admin/admin.php?page=linkup`} target="_blank" rel="noopener">{l.pasteLink}</a></p>
        </li>
        <li><a className="btn btn-primary" href={`/app?org=${orgId}`}>{l.done}</a></li>
      </ol>
    );
  }
  return (
    <form action={action} className="card stack">
      <input type="hidden" name="org" value={orgId} />
      {state.error && <p className="alert alert-error">{errors[state.error] ?? errors.unknown}</p>}
      <label className="field"><span>{l.site}</span>
        <input name="site" required dir="ltr" inputMode="url" placeholder="myshop.co.il" defaultValue={defaultSite} /></label>
      <button className={rotate ? "btn btn-ghost" : "btn btn-primary"} disabled={pending}>{pending ? "…" : rotate ? l.rotate : l.create}</button>
    </form>
  );
}
