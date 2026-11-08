import Link from "next/link";
import type { ReactNode } from "react";
import type { Org } from "@/lib/orgs";
import { ORG_LABEL } from "@/lib/format";

export function Shell({ org, orgs, children }: { org?: Org; orgs?: Org[]; children: ReactNode }) {
  return (
    <div className="shell">
      <header className="topbar">
        <Link href={org ? `/app?org=${org.id}` : "/app"} className="logo">LINKUP</Link>
        {org && (
          <details className="switcher">
            <summary>
              {org.name} <span className="muted">· {ORG_LABEL[org.type]}</span>
            </summary>
            <div className="menu">
              {orgs?.map((o) => (
                <Link key={o.id} href={`/app?org=${o.id}`}>{o.name} <span className="muted">· {ORG_LABEL[o.type]}</span></Link>
              ))}
              <Link href="/app/new">+ חשבון נוסף</Link>
              <form action="/auth/signout" method="post"><button className="linklike">יציאה</button></form>
            </div>
          </details>
        )}
      </header>
      <main className="page">{children}</main>
    </div>
  );
}

export function Alert({ text, kind = "error" }: { text: string | null; kind?: "error" | "ok" }) {
  if (!text) return null;
  return <p className={`alert alert-${kind}`} role={kind === "error" ? "alert" : "status"}>{text}</p>;
}
