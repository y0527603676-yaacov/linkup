"use client";
import { useState } from "react";

type L = { sale: string; commission: string; fee: string; keep: string; note: string };

/** Illustration only. The LINKUP fee slider starts at the current founders rate (2%); the real rate is set by the terms.
 *  Formula (unchanged): creator = sale × commission%, LINKUP = sale × fee%, left = sale − creator − LINKUP. */
export function PriceCalc({ l, locale }: { l: L; locale: "he" | "en" }) {
  const [sale, setSale] = useState(1000);
  const [rate, setRate] = useState(10);
  const [fee, setFee] = useState(2);
  const fmt = (n: number) => new Intl.NumberFormat(locale === "he" ? "he-IL" : "en-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 }).format(n);
  const toCreator = (sale * rate) / 100;
  const toLinkup = (sale * fee) / 100;
  const keep = sale - toCreator - toLinkup;
  const pct = (n: number) => `${Math.max(0, (n / sale) * 100)}%`;
  const fill = (v: number, min: number, max: number) => ({ "--fill": `${((v - min) / (max - min)) * 100}%` }) as React.CSSProperties;
  return (
    <div className="calc2">
      <div className="calc-controls">
        <label className="slider">
          <span className="slider-top"><bdi>{l.sale}</bdi><output className="pill"><bdi>{fmt(sale)}</bdi></output></span>
          <input type="range" min={100} max={10000} step={100} value={sale} style={fill(sale, 100, 10000)} onChange={(e) => setSale(Number(e.target.value))} />
        </label>
        <label className="slider">
          <span className="slider-top"><bdi>{l.commission}</bdi><output className="pill c-accent"><bdi>{rate}%</bdi></output></span>
          <input type="range" min={1} max={50} step={1} value={rate} style={fill(rate, 1, 50)} onChange={(e) => setRate(Number(e.target.value))} />
        </label>
        <label className="slider">
          <span className="slider-top"><bdi>{l.fee}</bdi><output className="pill c-brand"><bdi>{fee}%</bdi></output></span>
          <input type="range" min={0} max={10} step={0.5} value={fee} style={fill(fee, 0, 10)} onChange={(e) => setFee(Number(e.target.value))} />
        </label>
        <p className="small muted calc-note">{l.note}</p>
      </div>
      <div className="calc-result" aria-live="polite">
        <span className="calc-keep-label">{l.keep}</span>
        <b className="calc-keep">{fmt(keep)}</b>
        <div className="split-bar" aria-hidden="true">
          <i className="seg-keep" style={{ width: pct(keep) }} />
          <i className="seg-creator" style={{ width: pct(toCreator) }} />
          <i className="seg-linkup" style={{ width: pct(toLinkup) }} />
        </div>
        <ul className="legend">
          <li><i className="dot seg-creator" /><span>{l.commission}</span><b>{fmt(toCreator)}</b></li>
          <li><i className="dot seg-linkup" /><span>{l.fee}</span><b>{fmt(toLinkup)}</b></li>
          <li className="legend-keep"><i className="dot seg-keep" /><span>{l.keep}</span><b>{fmt(keep)}</b></li>
        </ul>
      </div>
    </div>
  );
}
