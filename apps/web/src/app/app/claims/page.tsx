import { AppShell, PageHead, Alert } from "@/components/AppShell";
import { loadApp } from "@/lib/orgs";
import { errorText, money, shortDate, date } from "@/lib/format";
import { answerSaleClaim, openSaleClaim } from "../actions";

type Claim = { id: string; order_ref: string; order_date: string | null; amount_minor: number | null; note: string | null; status: string;
  store_response: string | null; created_at: string; store: string; creator: string; mine_as: "store" | "creator" };
type Partner = { agreement_id: string; store_name: string; tracking: string };

/** Sale inquiries: a creator reports a missing or wrong sale; the store accepts (and reports it) or explains. */
export default async function Claims({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp);
  const { sb, org, t, locale } = ctx;
  const c = t.uc.claims;
  const isCreator = org.type === "creator";
  const [{ data: claims }, { data: partners }] = await Promise.all([
    sb.rpc("sale_claims_for", { p_org: org.id }),
    isCreator ? sb.rpc("my_partner_stores", { p_creator: org.id }) : Promise.resolve({ data: [] }),
  ]);
  const list = (claims ?? []) as Claim[];
  const ps = (partners ?? []) as Partner[];
  return (
    <AppShell ctx={ctx} active={isCreator ? "partnerships" : "settings"} path="/app/claims">
      <div className="narrow">
        <PageHead title={c.title} lead={isCreator ? c.leadCreator : c.leadStore} />
        <Alert text={errorText(sp.error, t)} />
        {sp.ok && c.ok[sp.ok] && <Alert kind="ok" text={c.ok[sp.ok]} />}

        {isCreator && ps.length > 0 && (
          <details className="card stack" open={!list.length}>
            <summary><b>{c.openTitle}</b></summary>
            <form action={openSaleClaim} className="stack" style={{ marginTop: 8 }}>
              <input type="hidden" name="org" value={org.id} />
              <label className="field"><span>{c.store}</span>
                <select name="agreement" required>{ps.map((p) => <option key={p.agreement_id} value={p.agreement_id}>{p.store_name}</option>)}</select></label>
              <label className="field"><span>{c.order}</span><input name="order" required maxLength={64} /></label>
              <label className="field"><span>{c.date}</span><input name="date" type="date" max={new Date().toISOString().slice(0, 10)} /></label>
              <label className="field"><span>{c.amount}</span><input name="amount" inputMode="decimal" dir="ltr" /></label>
              <label className="field"><span>{c.note}</span><textarea name="note" maxLength={500} rows={3} /></label>
              <button className="btn btn-primary">{c.submit}</button>
            </form>
          </details>
        )}

        <section className="stack" style={{ marginTop: 16 }}>
          {!list.length && <p className="muted">{c.empty}</p>}
          {list.map((x) => (
            <div key={x.id} className="card card-flat stack" style={{ gap: 6 }}>
              <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
                <b>{x.mine_as === "store" ? x.creator : x.store} · <span className="ltr">{x.order_ref}</span></b>
                <span className="badge">{c.status[x.status] ?? x.status}</span>
              </div>
              <p className="small muted" style={{ margin: 0 }}>{shortDate(x.created_at, locale)}
                {x.order_date && <> · {date(x.order_date, locale)}</>}{x.amount_minor && <> · {money(x.amount_minor, "ILS", locale)}</>}</p>
              {x.note && <p className="small" style={{ margin: 0 }}>{x.note}</p>}
              {x.store_response && <p className="small" style={{ margin: 0 }}><b>{c.response}:</b> {x.store_response}</p>}
              {x.status === "open" && x.mine_as === "store" && (
                <div className="stack" style={{ gap: 8 }}>
                  <form action={answerSaleClaim}><input type="hidden" name="org" value={org.id} /><input type="hidden" name="claim" value={x.id} />
                    <input type="hidden" name="status" value="accepted" /><button className="btn btn-primary btn-sm">{c.accept}</button></form>
                  <p className="small muted" style={{ margin: 0 }}>{c.acceptNote}</p>
                  <form action={answerSaleClaim} className="stack" style={{ gap: 6 }}><input type="hidden" name="org" value={org.id} /><input type="hidden" name="claim" value={x.id} />
                    <input type="hidden" name="status" value="rejected" />
                    <label className="field"><span>{c.reason}</span><input name="response" required minLength={2} maxLength={500} /></label>
                    <button className="btn btn-ghost btn-sm">{c.reject}</button></form>
                </div>
              )}
              {x.status === "open" && x.mine_as === "creator" && (
                <form action={answerSaleClaim}><input type="hidden" name="org" value={org.id} /><input type="hidden" name="claim" value={x.id} />
                  <input type="hidden" name="status" value="withdrawn" /><button className="btn btn-ghost btn-sm">{c.withdraw}</button></form>
              )}
            </div>
          ))}
        </section>
      </div>
    </AppShell>
  );
}
