import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { getT } from "@/i18n";
import { getOrigin } from "@/lib/supabase/server";
import "@fontsource/rubik/hebrew-400.css";
import "@fontsource/rubik/hebrew-500.css";
import "@fontsource/rubik/hebrew-600.css";
import "@fontsource/rubik/hebrew-700.css";
import "@fontsource/rubik/hebrew-800.css";
import "@fontsource/rubik/latin-400.css";
import "@fontsource/rubik/latin-500.css";
import "@fontsource/rubik/latin-600.css";
import "@fontsource/rubik/latin-700.css";
import "@fontsource/rubik/latin-800.css";
import "./globals.css";
import { Suspense } from "react";
import { NavFeedback } from "@/components/NavFeedback";

export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getT();
  return {
    title: { default: t.meta.title, template: "%s · LINKUP" },
    description: t.meta.description,
    applicationName: "LINKUP",
    appleWebApp: { capable: true, title: "LINKUP", statusBarStyle: "default" },
    metadataBase: new URL(await getOrigin()),
    icons: {
      icon: [{ url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" }, { url: "/icons/favicon-48.png", sizes: "48x48", type: "image/png" }, { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
    },
    openGraph: {
      title: t.meta.title, description: t.meta.description, siteName: "LINKUP", locale: locale === "he" ? "he_IL" : "en_US", type: "website",
      images: [{ url: "/brand/og-image.jpg", width: 1200, height: 630, alt: "LINKUP" }],
    },
    twitter: { card: "summary_large_image", title: t.meta.title, description: t.meta.description, images: ["/brand/og-image.jpg"] },
  };
}

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#5b3df5" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { locale, dir } = await getT();
  return (
    <html lang={locale} dir={dir}>
      <head>
      </head>
      <body><Suspense fallback={null}><NavFeedback /></Suspense>{children}</body>
    </html>
  );
}
