import { AppShell, PageHead } from "@/components/AppShell";
import { loadApp } from "@/lib/orgs";
import { money } from "@/lib/format";

export default async function Products({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await loadApp(await searchParams, "store");
  const { sb, org, t, locale } = ctx;
  const { data } = await sb.from("products").select("id, name, image_url, price_minor, currency, in_stock, stock_qty, permalink")
    .eq("store_org_id", org.id).eq("status", "active").order("in_stock", { ascending: false }).order("name").limit(500);
  const items = data ?? [];
  return (
    <AppShell ctx={ctx} active="products" path="/app/products">
      <PageHead title={t.products.title} lead={items.length ? t.products.count(items.length) : t.products.lead} />
      {items.length === 0 ? <p className="empty">{t.products.empty}</p> : (
        <div className="list">
          {items.map((p) => (
            <div className="item" key={p.id}>
              <div className="row grow" style={{ flexWrap: "nowrap" }}>
                {p.image_url
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={p.image_url} alt="" width={48} height={48} style={{ borderRadius: 10, objectFit: "cover", width: 48, height: 48 }} loading="lazy" />
                  : <span style={{ width: 48, height: 48, borderRadius: 10, background: "var(--surface-2)", flex: "none" }} />}
                <div className="grow"><div className="title">{p.permalink ? <a href={p.permalink} target="_blank" rel="noopener">{p.name}</a> : p.name}</div>
                  <div className="meta">{p.price_minor != null ? money(p.price_minor, p.currency, locale) : "—"}{p.stock_qty != null ? ` · ${p.stock_qty}` : ""}</div></div>
              </div>
              <span className={`badge ${p.in_stock ? "badge-money" : "badge-warn"}`}>{p.in_stock ? t.products.inStock : t.products.outOfStock}</span>
            </div>
          ))}
        </div>
      )}
    </AppShell>
  );
}
