import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { getT } from "@/i18n";
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
      </head>
      <body>{children}</body>
    </html>
  );
}
