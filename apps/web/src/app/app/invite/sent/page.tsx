import Link from "next/link";
import { AppShell, PageHead } from "@/components/AppShell";
import { ShareButtons } from "@/components/ShareButtons";
import { loadApp } from "@/lib/orgs";
import { getOrigin } from "@/lib/supabase/server";

export default async function Sent({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp);
  const { org, t } = ctx;
  const token = /^[0-9a-f]{24}$/.test(sp.token ?? "") ? sp.token! : "";
  const link = `${await getOrigin()}/o/${token}`;
  const name = (sp.name ?? "").slice(0, 60);
  const text = org.type === "store" ? t.invite.waStore(name, link) : t.invite.waCreator(name, link);
  return (
    <AppShell ctx={ctx} active={org.type === "store" ? "partners" : "partnerships"} path="/app/invite/sent">
      <div className="narrow">
        <PageHead title={t.invite.sentTitle} lead={t.invite.sentLead} />
        <div className="card stack">
          <div className="keybox" dir="ltr">{link}</div>
          <ShareButtons org={org.id} text={text} copyText={link} labels={{ wa: t.invite.send, copy: t.common.copy, copied: t.common.copied }} />
        </div>
        <p className="center section"><Link href={`/app/invite?org=${org.id}`}>{t.invite.another}</Link></p>
      </div>
    </AppShell>
  );
}
