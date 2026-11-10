import type { Metadata } from "next";
import { PublicPage } from "@/components/Site";
import { Alert } from "@/components/AppShell";
import { getT } from "@/i18n";
import { errorText } from "@/lib/format";
import { sendContact } from "@/app/app/actions";

export const metadata: Metadata = { title: "Contact" };

export default async function Contact({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { t } = await getT();
  const c = t.contact;
  const topic = sp.topic && c.topics[sp.topic] ? sp.topic : "general";
  return (
    <PublicPage path="/contact">
      <section className="container" style={{ padding: "40px 16px 80px", maxWidth: 560 }}>
        <h1>{c.title}</h1>
        <p className="muted">{c.lead}</p>
        <Alert text={errorText(sp.error, t)} />
        {sp.sent ? <Alert kind="ok" text={c.sent} /> : (
          <form action={sendContact} className="card stack">
            <label className="field"><span>{c.name}</span><input name="name" required minLength={2} maxLength={120} /></label>
            <label className="field"><span>{c.email}</span><input name="email" type="email" required dir="ltr" maxLength={200} /></label>
            <label className="field"><span>{c.topic}</span>
              <select name="topic" defaultValue={topic}>{Object.entries(c.topics).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="field"><span>{c.message}</span><textarea name="message" required minLength={5} maxLength={4000} rows={6} /></label>
            <p className="small muted">{c.note}</p>
            <button className="btn btn-primary">{c.send}</button>
          </form>
        )}
      </section>
    </PublicPage>
  );
}
