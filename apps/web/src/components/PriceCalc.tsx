"use client";
import { useState } from "react";

type L = { sale: string; commission: string; fee: string; keep: string; note: string };

/** Illustration only. The LINKUP fee slider starts at the current founders rate (2%); the real rate is set by the terms. */
export function PriceCalc({ l, locale }: { l: L; locale: "he" | "en" }) {
  const [sale, setSale] = useState(1000);
  const [rate, setRate] = useState(10);
  const [fee, setFee] = useState(2);
  const fmt = (n: number) => new Intl.NumberFormat(locale === "he" ? "he-IL" : "en-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 }).format(n);
  const toCreator = (sale * rate) / 100;
  const toLinkup = (sale * fee) / 100;
  return (
    <div className="card calc">
      <div className="stack">
        <label className="field">
          <span><bdi>{l.sale}</bdi>: <b><bdi>{fmt(sale)}</bdi></b></span>
          <input type="range" min={100} max={10000} step={100} value={sale} onChange={(e) => setSale(Number(e.target.value))} />
        </label>
        <label className="field">
          <span><bdi>{l.commission}</bdi>: <b><bdi>{rate}%</bdi></b></span>
          <input type="range" min={1} max={50} step={1} value={rate} onChange={(e) => setRate(Number(e.target.value))} />
        </label>
        <label className="field">
          <span><bdi>{l.fee}</bdi>: <b><bdi>{fee}%</bdi></b></span>
          <input type="range" min={0} max={10} step={0.5} value={fee} onChange={(e) => setFee(Number(e.target.value))} />
        </label>
        <p className="small muted">{l.note}</p>
      </div>
      <div className="out" aria-live="polite">
        <div><span>{l.commission}</span><b>{fmt(toCreator)}</b></div>
        <div><span>{l.fee}</span><b>{fmt(toLinkup)}</b></div>
        <div className="keep"><span>{l.keep}</span><b>{fmt(sale - toCreator - toLinkup)}</b></div>
      </div>
    </div>
  );
}
