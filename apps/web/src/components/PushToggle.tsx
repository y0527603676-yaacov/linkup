"use client";
import { useEffect, useState } from "react";
import { VAPID_PUBLIC_KEY } from "@/lib/push";
import { savePushSubscription, removePushSubscription } from "@/app/app/actions";

export type PushCopy = {
  title: string; lead: string; enable: string; enabling: string; on: string; off: string; disable: string;
  blocked: string; iosInstall: string; unsupported: string; failed: string; note: string;
};
type State = "loading" | "unsupported" | "ios-install" | "blocked" | "off" | "working" | "on" | "failed";

const b64 = (s: string) => {
  const p = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + p).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const key = (sub: PushSubscription, name: "p256dh" | "auth") => {
  const k = sub.getKey(name);
  return k ? btoa(String.fromCharCode(...new Uint8Array(k))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : "";
};

/**
 * Sale alerts on this phone or computer (Web Push). Opt-in, per device. iPhone/iPad: works after adding LINKUP to the
 * home screen (Apple's rule), so the card explains that first. The service worker only displays notifications.
 */
export function PushToggle({ copy, compact = false }: { copy: PushCopy; compact?: boolean }) {
  const [s, setS] = useState<State>("loading");

  useEffect(() => {
    (async () => {
      const ua = navigator.userAgent;
      const ios = /iPhone|iPad|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
      const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        setS(ios && !standalone ? "ios-install" : "unsupported"); return;
      }
      if (Notification.permission === "denied") { setS("blocked"); return; }
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      setS(sub && Notification.permission === "granted" ? "on" : "off");
    })().catch(() => setS("unsupported"));
  }, []);

  const enable = async () => {
    setS("working");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setS(perm === "denied" ? "blocked" : "off"); return; }
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription())
        ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(VAPID_PUBLIC_KEY) });
      const r = await savePushSubscription({ endpoint: sub.endpoint, p256dh: key(sub, "p256dh"), auth: key(sub, "auth") }, navigator.userAgent);
      if (!r.ok) throw new Error(r.error ?? "save");
      setS("on");
      reg.showNotification("LINKUP", { body: copy.on, icon: "/icons/icon-192.png", tag: "linkup-push-on", lang: "he", dir: "auto" }).catch(() => {});
    } catch { setS("failed"); }
  };
  const disable = async () => {
    setS("working");
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) { await removePushSubscription(sub.endpoint); await sub.unsubscribe(); }
      setS("off");
    } catch { setS("failed"); }
  };

  if (s === "loading" || (compact && (s === "on" || s === "unsupported"))) return null;
  return (
    <div className={`push-card ${s === "on" ? "is-on" : ""}`} role="region" aria-label={copy.title}>
      <div className="push-icon" aria-hidden>{s === "on" ? "🔔" : "🔕"}</div>
      <div className="grow">
        <div className="title">{copy.title}</div>
        <p className="small muted" style={{ margin: "2px 0 0" }}>
          {s === "on" ? copy.on : s === "blocked" ? copy.blocked : s === "ios-install" ? copy.iosInstall
            : s === "unsupported" ? copy.unsupported : s === "failed" ? copy.failed : copy.lead}
        </p>
        {(s === "off" || s === "working" || s === "failed") && <p className="small muted" style={{ margin: "4px 0 0" }}>{copy.note}</p>}
      </div>
      {(s === "off" || s === "failed") && <button className="btn btn-primary btn-sm" onClick={enable}>{copy.enable}</button>}
      {s === "working" && <button className="btn btn-primary btn-sm" disabled aria-busy="true">{copy.enabling}</button>}
      {s === "on" && !compact && <button className="btn btn-ghost btn-sm" onClick={disable}>{copy.disable}</button>}
    </div>
  );
}
