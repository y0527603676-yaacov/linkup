import type { MetadataRoute } from "next";

/** Installable app: opens straight to the user's dashboard. No service worker and no offline cache, so no data is stored on the device. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/app",
    name: "LINKUP",
    short_name: "LINKUP",
    description: "חנויות ומשפיענים צומחים יחד",
    lang: "he",
    dir: "rtl",
    start_url: "/app?source=pwa",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#f7f7f4",
    theme_color: "#5b3df5",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "הדשבורד", short_name: "דשבורד", url: "/app?source=pwa", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "כסף ותשלומים", short_name: "כסף", url: "/app/money?source=pwa", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "עדכונים", short_name: "עדכונים", url: "/app/notifications?source=pwa", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
