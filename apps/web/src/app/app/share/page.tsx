import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, PageHead } from "@/components/AppShell";
import { ShareButtons } from "@/components/ShareButtons";
import { StoryMaker } from "@/components/StoryMaker";
import { loadApp } from "@/lib/orgs";
import { getOrigin } from "@/lib/supabase/server";
import { money } from "@/lib/format";

export default async function Share({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await loadApp(sp, "creator");
  const { sb, org, t, locale, dir } = ctx;
  const s = t.share;
  if (!/^[A-Za-z0-9]{4,16}$/.test(sp.code ?? "")) notFound();
  const { data: pc } = await sb.from("partner_codes").select("code, agreements!inner(store_org_id, creator_org_id, organizations!agreements_store_org_id_fkey(name))")
    .eq("code", sp.code!.toUpperCase()).eq("active", true).maybeSingle();
  const ag = (pc as any)?.agreements;
  if (!pc || ag?.creator_org_id !== org.id) notFound();
  const storeName: string = ag.organizations?.name ?? "";
  const [{ data: ver }, { data: products }] = await Promise.all([
    sb.from("agreement_versions").select("coupon_discount_pct, agreements!inner(store_org_id, creator_org_id)").eq("agreements.creator_org_id", org.id).eq("agreements.store_org_id", ag.store_org_id).order("version", { ascending: false }).limit(1),
    sb.from("products").select("id, name, image_url, price_minor, currency, permalink").eq("store_org_id", ag.store_org_id).eq("status", "active").eq("in_stock", true).order("synced_at", { ascending: false }).limit(24),
  ]);
  const discount = (ver?.[0] as any)?.coupon_discount_pct ?? 10;
  const product = (products ?? []).find((p) => p.id === sp.p);
  const link = `${await getOrigin()}/r/${pc.code}`;
  const fmt = sp.f === "story" || sp.f === "post" ? sp.f : "whatsapp";
  const text = fmt === "post" ? s.post(storeName, pc.code, discount, link, product?.name) : s.wa(storeName, pc.code, discount, link, product?.name);
  const base = `/app/share?org=${org.id}&code=${pc.code}`;
  return (
    <AppShell ctx={ctx} active="partnerships" path="/app/share">
      <PageHead title={s.title} lead={`${storeName} · ${s.lead}`} />
      <nav className="tabs" aria-label={s.title}>
        {(["whatsapp", "story", "post"] as const).map((f) => (
          <Link key={f} className={`tab${fmt === f ? " on" : ""}`} href={`${base}&f=${f}${product ? `&p=${product.id}` : ""}`}>{s.formats[f]}</Link>
        ))}
      </nav>
      {(products ?? []).length > 0 && (
        <section className="section" style={{ marginTop: 8 }}>
          <h3>{s.product}</h3>
          <div className="tabs">
            <Link className={`tab${!product ? " on" : ""}`} href={`${base}&f=${fmt}`}>{s.noProduct}</Link>
            {(products ?? []).map((p) => (
              <Link key={p.id} className={`tab${product?.id === p.id ? " on" : ""}`} href={`${base}&f=${fmt}&p=${p.id}`}>
                {p.name.slice(0, 28)}{p.price_minor != null ? ` · ${money(p.price_minor, p.currency, locale)}` : ""}
              </Link>
            ))}
          </div>
        </section>
      )}
      <div className="card stack section">
        {fmt === "story" ? (
          <StoryMaker org={org.id} store={storeName} code={pc.code} discount={discount} link={link} dir={dir}
            product={product ? { name: product.name, img: product.image_url ? `/api/product-image/${product.id}` : null } : undefined}
            labels={{ cta: s.storyCta, swipe: s.swipe, download: s.download, share: s.shareNow }} />
        ) : (
          <>
            <h3>{s.text}</h3>
            <p style={{ whiteSpace: "pre-wrap", background: "var(--surface-2)", padding: 14, borderRadius: 12 }}>{text}</p>
            <ShareButtons org={org.id} text={text} labels={{ wa: t.common.shareWhatsapp, copy: t.common.copy, copied: t.common.copied }} />
          </>
        )}
      </div>
    </AppShell>
  );
}
