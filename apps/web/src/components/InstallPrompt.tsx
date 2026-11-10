"use client";
import { useEffect, useState } from "react";

type Copy = { text: string; install: string; later: string; iosSteps: string };
type BIPEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

const KEY = "lk_install_dismissed";
const dismissed = () => { try { return localStorage.getItem(KEY) === "1" || document.cookie.includes(`${KEY}=1`); } catch { return false; } };
const remember = () => {
  try { localStorage.setItem(KEY, "1"); } catch { /* private mode */ }
  document.cookie = `${KEY}=1; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
};

/**
 * One gentle, dismissible suggestion to add LINKUP to the home screen.
 * Android/Chrome: the browser's own install dialog. iPhone/iPad Safari: two-step instructions.
 * Never shown inside the installed app, and never again after "Not now" or after installing.
 */
export function InstallPrompt({ copy }: { copy: Copy }) {
  const [mode, setMode] = useState<"none" | "native" | "ios">("none");
  const [evt, setEvt] = useState<BIPEvent | null>(null);

  useEffect(() => {
    const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
    if (standalone || dismissed()) return;
    const onBip = (e: Event) => { e.preventDefault(); setEvt(e as BIPEvent); setMode("native"); };
    const onInstalled = () => { remember(); setMode("none"); };
    window.addEventListener("beforeinstallprompt", onBip);
    window.addEventListener("appinstalled", onInstalled);
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
    if (ios) setMode("ios");
    return () => { window.removeEventListener("beforeinstallprompt", onBip); window.removeEventListener("appinstalled", onInstalled); };
  }, []);

  if (mode === "none") return null;
  const close = () => { remember(); setMode("none"); };
  const install = async () => {
    if (!evt) return;
    await evt.prompt();
    const { outcome } = await evt.userChoice;
    if (outcome === "accepted") remember();
    setMode("none");
  };
  return (
    <div className="install-tip" role="region" aria-label="LINKUP">
      <img src="/icons/icon-192.png" alt="" width={36} height={36} />
      <div className="stack" style={{ gap: 4, flex: 1 }}>
        <span>{copy.text}</span>
        {mode === "ios" && <span className="small muted">{copy.iosSteps}</span>}
      </div>
      <div className="row" style={{ gap: 6 }}>
        {mode === "native" && <button type="button" className="btn btn-primary btn-sm" onClick={install}>{copy.install}</button>}
        <button type="button" className="btn btn-ghost btn-sm" onClick={close}>{copy.later}</button>
      </div>
    </div>
  );
}
