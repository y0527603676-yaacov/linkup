import Link from "next/link";
import type { ReactNode } from "react";
import { getT } from "@/i18n";
import { getSupabase } from "@/lib/supabase/server";
import { getUser } from "@/lib/supabase/server";

export function Logo({ href = "/" }: { href?: string }) {
  return <Link href={href} className="logo" aria-label="LINKUP"><i aria-hidden /> <span>LINKUP</span></Link>;
}

export async function SiteHeader({ path = "/" }: { path?: string }) {
  const { t, locale } = await getT();
  const user = await getUser();
  return (
    <header className="site-header">
      <div className="in">
        <Logo />
        <nav className="site-nav" aria-label="main">
          <Link className="hide-sm" href="/stores">{t.common.stores}</Link>
          <Link className="hide-sm" href="/creators">{t.common.creators}</Link>
          <a href={`/lang?to=${locale === "he" ? "en" : "he"}&next=${encodeURIComponent(path)}`} lang={locale === "he" ? "en" : "he"}>{t.common.langSwitch}</a>
          {user ? <Link className="btn btn-primary btn-sm" href="/app">LINKUP</Link>
                : <Link className="btn btn-ghost btn-sm" href="/login">{t.common.login}</Link>}
        </nav>
      </div>
    </header>
  );
}

export async function SiteFooter() {
  const { t } = await getT();
  // The cookies notice points to the published policy; it is shown only once that policy is published.
  const { data: ck } = await (await getSupabase()).from("legal_documents").select("id").eq("doc_key", "cookies").eq("status", "published").limit(1);
  const cookiesPublished = (ck ?? []).length > 0;
  return (
    <footer className="site-footer">
      <div className="container row between">
        <span>© {new Date().getFullYear()} {t.common.rights}</span>
        <span className="row">
          <Link href="/stores">{t.common.stores}</Link>
          <Link href="/creators">{t.common.creators}</Link>
          <Link href="/founding-partners">Founding Partners</Link>
          <Link href="/terms">{t.common.terms}</Link>
          <Link href="/privacy">{t.common.privacy}</Link>
          <Link href="/legal">{t.legal.footer}</Link>
          <Link href="/contact">{t.legal.contact}</Link>
        </span>
      </div>
      {cookiesPublished && <p className="container small muted" style={{ marginTop: 8 }}><Link href="/legal/cookies">{t.lc.cookies}</Link></p>}
    </footer>
  );
}

export async function PublicPage({ path, children }: { path: string; children: ReactNode }) {
  return (
    <>
      <SiteHeader path={path} />
      <main>{children}</main>
      <SiteFooter />
    </>
  );
}

export function Faq({ items }: { items: { q: string; a: string }[] }) {
  return <div className="faq">{items.map((f) => <details key={f.q}><summary>{f.q}</summary><p>{f.a}</p></details>)}</div>;
}
