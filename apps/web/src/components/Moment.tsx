"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

export type MomentKey =
  | "connected" | "store_created" | "creator_welcome" | "offer" | "campaign" | "joined" | "applied" | "accepted"
  | "approved" | "invite" | "paid" | "payout_confirmed" | "saved" | "first_sale";
export type MomentCopy = Record<MomentKey, { icon: string; title: string; text: string; cta?: string }> & { close: string; small: string };

/** Which moment a URL announces. `m=<key>` is the convention; older success flags still map to their moment. */
function fromParams(sp: URLSearchParams): MomentKey | null {
  const m = sp.get("m");
  if (m) return m as MomentKey;
  if (sp.get("wp") === "connected") return "connected";
  if (sp.get("ok") === "offer") return "offer";
  if (sp.get("ok") === "campaign") return "campaign";
  if (sp.get("ok") === "pending") return "applied";
  if (sp.get("ok") === "reported") return "paid";
  if (sp.get("joined") === "1") return "joined";
  if (sp.get("accepted") === "1") return "accepted";
  if (sp.get("welcome") === "1") return "creator_welcome";
  return null;
}
const FLAGS = ["m", "wp", "ok", "joined", "accepted", "welcome"];
const SMALL: MomentKey[] = ["saved", "payout_confirmed"];

/** Where each moment points next (the one thing worth doing now). */
function nextHref(k: MomentKey, org: string, isStore: boolean): string | null {
  const q = `?org=${org}`;
  switch (k) {
    case "connected": case "store_created": return isStore ? `/app/offer${q}` : null;
    case "offer": case "campaign": return `/app/invite${q}`;
    case "accepted": return isStore ? `/app/partners${q}` : `/app/partnerships${q}`;
    case "first_sale": return isStore ? `/app/partners${q}` : `/app/money${q}`;
    default: return null;
  }
}

/**
 * The "it happened" moment after an action: a short burst, what was just created, and the next step.
 * Small confirmations (saved) show as a quiet toast. The flag is removed from the address so a refresh doesn't replay it.
 * Respects reduced-motion. `force` lets a page announce a moment that didn't come from a URL (e.g. the first sale).
 */
export function Moment({ copy, org, isStore, force, onceKey }: {
  copy: MomentCopy; org: string; isStore: boolean; force?: MomentKey | null; onceKey?: string;
}) {
  const sp = useSearchParams();
  const [k, setK] = useState<MomentKey | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const key = force ?? fromParams(new URLSearchParams(sp.toString()));
    if (!key || !(key in copy)) return;
    if (onceKey) {
      try { if (localStorage.getItem(onceKey)) return; localStorage.setItem(onceKey, "1"); } catch { return; }
    }
    setK(key); setLeaving(false);
    try { navigator.vibrate?.(SMALL.includes(key) ? 15 : [20, 40, 30]); } catch { /* not supported */ }
    // Clean the address (keep everything else, e.g. org and error).
    const u = new URL(location.href);
    let changed = false;
    for (const f of FLAGS) {
      if (f === "ok" && !["offer", "campaign", "pending", "reported"].includes(u.searchParams.get("ok") ?? "")) continue;
      if (u.searchParams.has(f)) { u.searchParams.delete(f); changed = true; }
    }
    if (changed) history.replaceState(history.state, "", u.pathname + (u.search ? u.search : "") + u.hash);
    if (SMALL.includes(key)) { const t = setTimeout(() => close(), 2200); return () => clearTimeout(t); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp, force]);

  const close = () => { setLeaving(true); setTimeout(() => setK(null), 220); };
  if (!k) return null;
  const c = copy[k];
  const href = nextHref(k, org, isStore);

  if (SMALL.includes(k)) {
    return <div className={`moment-toast ${leaving ? "out" : ""}`} role="status" aria-live="polite"><span aria-hidden>{c.icon}</span> {c.title}</div>;
  }
  return (
    <div className={`moment-backdrop ${leaving ? "out" : ""}`} onClick={close}>
      <div className="moment" role="dialog" aria-modal="true" aria-labelledby="moment-title" onClick={(e) => e.stopPropagation()}>
        <div className="moment-burst" aria-hidden>
          {Array.from({ length: 14 }, (_, i) => <i key={i} style={{ ["--a" as string]: `${(360 / 14) * i}deg`, ["--d" as string]: `${(i % 3) * 40}ms` }} />)}
          <span className="moment-icon">{c.icon}</span>
        </div>
        <h2 id="moment-title">{c.title}</h2>
        <p>{c.text}</p>
        <div className="row" style={{ justifyContent: "center", gap: 10, flexWrap: "wrap" }}>
          {href && c.cta && <a className="btn btn-primary" href={href}>{c.cta}</a>}
          <button type="button" className={`btn ${href && c.cta ? "btn-ghost" : "btn-primary"}`} onClick={close} autoFocus={!href}>{copy.close}</button>
        </div>
      </div>
    </div>
  );
}
