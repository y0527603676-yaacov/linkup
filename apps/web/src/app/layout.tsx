import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { getT } from "@/i18n";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getT();
  return {
    title: { default: t.meta.title, template: "%s · LINKUP" },
    description: t.meta.description,
    openGraph: { title: t.meta.title, description: t.meta.description, siteName: "LINKUP", locale: locale === "he" ? "he_IL" : "en_US", type: "website" },
  };
}

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#5b3df5" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { locale, dir } = await getT();
  return (
    <html lang={locale} dir={dir}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
