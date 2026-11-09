"use client";
import { useState } from "react";

type L = { sale: string; commission: string; toCreator: string; toLinkup: string; youKeep: string; founders: string };

export function PriceCalc({ l, locale }: { l: L; locale: "he" | "en" }) {
  const [sale, setSale] = useState(1000);
  const [rate, setRate] = useState(10);
  const fmt = (n: number) => new Intl.NumberFormat(locale === "he" ? "he-IL" : "en-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 }).format(n);
  const toCreator = (sale * rate) / 100;
  const toLinkup = sale * 0.02;
  return (
    <div className="card calc">
      <div className="stack">
        <label className="field">
          <span>{l.sale}: <b>{fmt(sale)}</b></span>
          <input type="range" min={100} max={10000} step={100} value={sale} onChange={(e) => setSale(Number(e.target.value))} />
        </label>
        <label className="field">
          <span>{l.commission}: <b>{rate}%</b></span>
          <input type="range" min={3} max={30} step={1} value={rate} onChange={(e) => setRate(Number(e.target.value))} />
        </label>
        <p className="small muted">{l.founders}</p>
      </div>
      <div className="out" aria-live="polite">
        <div><span>{l.toCreator}</span><b>{fmt(toCreator)}</b></div>
        <div><span>{l.toLinkup} (2%)</span><b>{fmt(toLinkup)}</b></div>
        <div className="keep"><span>{l.youKeep}</span><b>{fmt(sale - toCreator - toLinkup)}</b></div>
      </div>
    </div>
  );
}
