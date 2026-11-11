/**
 * Product illustrations for the marketing pages, built from the real app's UI labels.
 * Every figure here is demo data and each illustration carries a visible "Illustration" badge.
 */
import type { Dict } from "@/i18n/he";
import { Icon } from "./Icons";

type L = "he" | "en";
const ils = (n: number, locale: L) =>
  new Intl.NumberFormat(locale === "he" ? "he-IL" : "en-IL", { style: "currency", currency: "ILS", maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);

function Badge({ t }: { t: Dict }) {
  return <span className="viz-badge">{t.demo.badge}</span>;
}

/** Home: store → creator (coupon + link) → attributed sale. */
export function HomeVisual({ t, locale }: { t: Dict; locale: L }) {
  const d = t.demo;
  return (
    <figure className="viz viz-home" role="img" aria-label={`${d.badge}: ${t.home.how.map((s) => s.t).join(" → ")}`}>
      <Badge t={t} />
      <svg className="viz-path" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path d="M30 22 C 30 40, 70 34, 70 52 S 34 66, 34 80" />
      </svg>
      <div className="viz-card v-store">
        <span className="tile t-brand"><Icon name="store" /></span>
        <div className="grow"><b>{d.store}</b><small>{t.common.orgType.store}</small></div>
        <div className="chips"><span className="chip">{t.creators.commission} 10%</span><span className="chip">{t.creators.discount} 10%</span></div>
      </div>
      <div className="viz-card v-creator">
        <span className="avatar">{d.creator.slice(0, 1)}</span>
        <div className="grow"><b>{d.creator}</b><small className="ltr">{d.creatorHandle}</small></div>
        <div className="codes">
          <span className="code"><Icon name="ticket" size={16} /> <span className="ltr">{d.code}</span></span>
          <span className="code"><Icon name="link" size={16} /> <span className="ltr">…/r/{d.code}</span></span>
        </div>
      </div>
      <div className="viz-card v-sale">
        <span className="tile t-money"><Icon name="bag" /></span>
        <div className="grow"><b>{t.notifications.kinds.sale}</b><small>{t.dash.order} #1042 · {t.dash.via.coupon} · {d.code}</small></div>
        <div className="amount"><small>{t.dash.commission}</small><b>{ils(19.9, locale)}</b></div>
      </div>
    </figure>
  );
}

/** Stores: the store dashboard (KPIs + recent attributed sales). */
export function StoreDashVisual({ t, locale }: { t: Dict; locale: L }) {
  const d = t.demo; const ds = t.dash;
  const rows = [
    { o: 1042, n: d.names[0] ?? "", via: "coupon", c: 19.9 },
    { o: 1041, n: d.names[1] ?? "", via: "link", c: 32 },
    { o: 1039, n: d.names[2] ?? "", via: "coupon", c: 12.5 },
  ];
  return (
    <figure className="viz viz-window" role="img" aria-label={`${d.badge}: ${ds.storeTitle}`}>
      <Badge t={t} />
      <div className="win-bar" aria-hidden="true"><i /><i /><i /></div>
      <div className="win-body">
        <div className="win-head"><span className="tile t-brand sm"><Icon name="store" size={18} /></span><b>{ds.storeTitle}</b></div>
        <div className="kpis">
          <div className="kpi hl"><small>{ds.storeSales}</small><b>{ils(4280, locale)}</b></div>
          <div className="kpi"><small>{ds.storeComm}</small><b>{ils(428, locale)}</b></div>
          <div className="kpi"><small>{ds.storePartners}</small><b>6</b></div>
          <div className="kpi"><small>{ds.storeOffers}</small><b>1</b></div>
        </div>
        <div className="tbl">
          <div className="tbl-title">{ds.recentSales}</div>
          {rows.map((r) => (
            <div className="tr" key={r.o}>
              <span className="ltr muted">#{r.o}</span>
              <span className="who"><span className="avatar xs">{r.n.slice(0, 1)}</span>{r.n}</span>
              <span className="via"><Icon name={r.via === "coupon" ? "ticket" : "link"} size={14} /> {ds.via[r.via]}</span>
              <b className="money-t">{ils(r.c, locale)}</b>
            </div>
          ))}
        </div>
      </div>
    </figure>
  );
}

/** Creators: opportunity → personal coupon & link → earnings. */
export function CreatorVisual({ t, locale }: { t: Dict; locale: L }) {
  const d = t.demo; const p = t.partnerships; const m = t.money;
  return (
    <figure className="viz viz-phone" role="img" aria-label={`${d.badge}: ${t.creators.steps.join(" → ")}`}>
      <Badge t={t} />
      <div className="phone">
        <div className="phone-notch" aria-hidden="true" />
        <div className="ph-card">
          <div className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
            <span className="tile t-brand sm"><Icon name="store" size={18} /></span>
            <div className="grow"><b>{d.store}</b></div>
          </div>
          <div className="chips"><span className="chip money">{p.rate} 10%</span><span className="chip">{p.discount} 10%</span></div>
          <span className="ph-btn">{t.catalog.collab}</span>
        </div>
        <div className="ph-card">
          <div className="kv"><small>{p.code}</small><span className="code big"><Icon name="ticket" size={16} /> <span className="ltr">{d.code}</span></span></div>
          <div className="kv"><small>{p.link}</small><span className="code"><Icon name="link" size={16} /> <span className="ltr">…/r/{d.code}</span></span></div>
        </div>
        <div className="ph-card">
          <div className="earn">
            <div><small>{m.cPending}</small><b>{ils(96, locale)}</b></div>
            <div><small>{m.cApproved}</small><b className="money-t">{ils(240, locale)}</b></div>
          </div>
          <div className="bars" aria-hidden="true">{[30, 45, 38, 60, 52, 75, 68].map((h, i) => <i key={i} style={{ height: `${h}%` }} />)}</div>
        </div>
      </div>
    </figure>
  );
}

/** Stores: LINKUP LAUNCH – a campaign notification as partners receive it. */
export function LaunchVisual({ t }: { t: Dict }) {
  return (
    <figure className="viz viz-launch" role="img" aria-label={`${t.demo.badge}: ${t.notifications.kinds.campaign_launched}`}>
      <Badge t={t} />
      <div className="viz-card">
        <span className="tile t-accent"><Icon name="bell" /></span>
        <div className="grow"><b>{t.notifications.kinds.campaign_launched}</b><small>{t.demo.store} · {t.dash.campaign}</small></div>
        <span className="rate-up"><span className="ltr">10% → 15%</span><Icon name="arrowUp" size={16} /></span>
      </div>
    </figure>
  );
}
