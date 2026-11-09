import Link from "next/link";
import type { ReactNode } from "react";
import type { Dict } from "@/i18n/he";
import type { Org, OrgStatus } from "@/lib/orgs";
import { Logo } from "./Site";

export type NavKey = "home" | "partners" | "offer" | "products" | "money" | "team" | "settings" | "catalog" | "partnerships" | "rewards" | "notifications" | "admin";

type Ctx = { t: Dict; org: Org; orgs: Org[]; status: OrgStatus; isPlatformAdmin: boolean; locale: "he" | "en" };

const ICON: Record<NavKey, string> = {
  home: "⌂", partners: "👥", offer: "🚀", products: "📦", money: "₪", team: "🧑‍🤝‍🧑", settings: "⚙︎",
  catalog: "🔎", partnerships: "🏷️", rewards: "★", notifications: "🔔", admin: "🛠",
};

export function AppShell({ ctx, active, children, path }: { ctx: Ctx; active: NavKey; children: ReactNode; path: string }) {
  const { t, org, orgs, status, isPlatformAdmin, locale } = ctx;
  const q = `?org=${org.id}`;
  const href = (k: NavKey) => (k === "home" ? `/app${q}` : `/app/${k}${q}`);
  const isStore = org.type === "store";
  const side: NavKey[] = isStore
    ? ["home", "partners", "offer", "products", "money", "rewards", "team", "settings"]
    : ["home", "catalog", "partnerships", "money", "rewards", "team", "settings"];
  const bottom: NavKey[] = isStore ? ["home", "partners", "offer", "money", "rewards"] : ["home", "catalog", "partnerships", "money", "rewards"];
  const badge = (k: NavKey) =>
    k === "partners" && status.pending_applications ? status.pending_applications
    : k === "money" && (status.open_invoices || status.payouts_to_confirm) ? status.open_invoices + status.payouts_to_confirm
    : 0;
  const visible = (k: NavKey) => status.is_admin || !["team", "money", "settings"].includes(k) || (k === "money" && !isStore);

  return (
    <div className="app">
      <aside className="side" aria-label="app">
        <Logo href={`/app${q}`} />
        {side.filter(visible).map((k) => (
          <Link key={k} className="nav" href={href(k)} aria-current={active === k ? "page" : undefined}>
            <span aria-hidden>{ICON[k]}</span> {t.nav[k]}
            {badge(k) > 0 && <span className="n">{badge(k)}</span>}
          </Link>
        ))}
        <div className="spacer" />
        {isPlatformAdmin && <Link className="nav" href={`/app/admin${q}`} aria-current={active === "admin" ? "page" : undefined}><span aria-hidden>{ICON.admin}</span> {t.nav.admin}</Link>}
      </aside>
      <div className="app-main">
        <header className="app-top">
          <Logo href={`/app${q}`} />
          <details className="switcher">
            <summary><span className="nm">{org.name}</span> <span className="badge">{t.common.orgType[org.type]}</span></summary>
            <div className="menu">
              {orgs.filter((o) => o.id !== org.id).map((o) => (
                <Link key={o.id} href={`/app?org=${o.id}`}><span>{o.name}</span><span className="badge">{t.common.orgType[o.type]}</span></Link>
              ))}
              <Link href="/app/new">{t.nav.addActivity}</Link>
              <a href={`/lang?to=${locale === "he" ? "en" : "he"}&next=${encodeURIComponent(path + q)}`}>{t.common.langSwitch}</a>
              {isPlatformAdmin && <Link href={`/app/admin${q}`}>{t.nav.admin}</Link>}
              <form action="/auth/signout" method="post"><button>{t.common.logout}</button></form>
            </div>
          </details>
          <div className="top-actions">
            <Link className="icon-btn" href={`/app/notifications${q}`} aria-label={t.nav.notifications}>
              🔔{status.unread > 0 && <span className="n">{status.unread}</span>}
            </Link>
          </div>
        </header>
        <main className="app-page">{children}</main>
      </div>
      <nav className="bottom-nav" aria-label="app-mobile">
        {bottom.filter(visible).map((k) => (
          <Link key={k} href={href(k)} aria-current={active === k ? "page" : undefined}>
            <b aria-hidden>{ICON[k]}</b>{t.nav[k]}
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function PageHead({ title, lead, children }: { title: string; lead?: string; children?: ReactNode }) {
  return (
    <div className="page-head row between">
      <div className="grow"><h1>{title}</h1>{lead && <p className="muted">{lead}</p>}</div>
      {children}
    </div>
  );
}

export function Alert({ text, kind = "error" }: { text: string | null | undefined; kind?: "error" | "ok" | "warn" }) {
  if (!text) return null;
  return <p className={`alert alert-${kind}`} role={kind === "error" ? "alert" : "status"}>{text}</p>;
}

export function NextAction({ eyebrow, title, text, cta, href }: { eyebrow: string; title: string; text: string; cta: string; href: string }) {
  return (
    <section className="next" aria-label={eyebrow}>
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      <p>{text}</p>
      <Link className="btn" href={href}>{cta}</Link>
    </section>
  );
}

export function Stat({ label, value, money }: { label: string; value: ReactNode; money?: boolean }) {
  return <div className={`stat${money ? " money" : ""}`}><b>{value}</b><span>{label}</span></div>;
}
