"use client";
import { useEffect, useRef, useState } from "react";
import { trackShare } from "@/app/app/actions";

type Props = {
  org: string; store: string; code: string; discount: number; link: string; product?: { name: string; img: string | null };
  dir: "rtl" | "ltr"; labels: { cta: string; swipe: string; download: string; share: string };
};

/** Draws a 1080×1920 story image in the browser (fonts already loaded, no server rendering needed). */
export function StoryMaker({ org, store, code, discount, link, product, dir, labels }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const c = ref.current; if (!c) return;
      const x = c.getContext("2d")!; const W = 1080, H = 1920;
      await document.fonts?.ready;
      const g = x.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, "#16142b"); g.addColorStop(.55, "#3b2aa8"); g.addColorStop(1, "#ff6b4a");
      x.fillStyle = g; x.fillRect(0, 0, W, H);
      x.direction = dir; x.textAlign = "center"; x.fillStyle = "#fff";
      x.font = "600 52px Rubik, sans-serif"; x.fillText(store, W / 2, 210);
      let y = 300;
      if (product?.img) {
        const im = new Image(); im.src = product.img;
        try {
          await im.decode();
          const size = 820, r = 48, ix = (W - size) / 2;
          x.save(); x.beginPath(); x.roundRect(ix, y, size, size, r); x.clip();
          const s = Math.max(size / im.width, size / im.height);
          x.drawImage(im, ix + (size - im.width * s) / 2, y + (size - im.height * s) / 2, im.width * s, im.height * s);
          x.restore(); y += size + 90;
        } catch { y += 120; }
      } else { y += 200; }
      if (product?.name) { x.font = "500 46px Rubik, sans-serif"; x.fillText(product.name.slice(0, 40), W / 2, y); y += 110; }
      x.font = "800 190px Rubik, sans-serif"; x.fillText(`-${discount}%`, W / 2, y + 120); y += 230;
      x.fillStyle = "#fff"; x.beginPath(); x.roundRect(170, y, W - 340, 170, 85); x.fill();
      x.fillStyle = "#16142b"; x.font = "500 36px Rubik, sans-serif"; x.fillText(labels.cta, W / 2, y + 62);
      x.font = "800 64px ui-monospace, Menlo, monospace"; x.fillText(code, W / 2, y + 135);
      x.fillStyle = "rgba(255,255,255,.9)"; x.font = "500 38px Rubik, sans-serif";
      x.fillText(labels.swipe, W / 2, H - 170); x.font = "400 34px Rubik, sans-serif"; x.fillText(link.replace(/^https?:\/\//, ""), W / 2, H - 110);
      c.toBlob((b) => { if (b && !cancelled) setUrl(URL.createObjectURL(b)); }, "image/png");
    })();
    return () => { cancelled = true; };
  }, [store, code, discount, link, product?.img, product?.name, dir, labels.cta, labels.swipe]);

  const share = async () => {
    if (!url) return;
    void trackShare(org, "creative_shared").catch(() => undefined);
    const blob = await (await fetch(url)).blob();
    const file = new File([blob], `linkup-${code}.png`, { type: "image/png" });
    if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file] }); } catch { /* cancelled */ } }
    else { const a = document.createElement("a"); a.href = url; a.download = file.name; a.click(); }
  };

  return (
    <div className="stack" style={{ justifyItems: "center" }}>
      <canvas ref={ref} width={1080} height={1920} hidden />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {url ? <img className="story-preview" src={url} alt="" /> : <div className="story-preview" />}
      <div className="row">
        <button type="button" className="btn btn-primary" onClick={share} disabled={!url}>{labels.share}</button>
        {url && <a className="btn btn-ghost" href={url} download={`linkup-${code}.png`} onClick={() => void trackShare(org, "creative_shared").catch(() => undefined)}>{labels.download}</a>}
      </div>
    </div>
  );
}
