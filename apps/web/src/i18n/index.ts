import "server-only";
import { cookies, headers } from "next/headers";
import { he, type Dict } from "./he";
import { en } from "./en";

export type Locale = "he" | "en";
export const LOCALE_COOKIE = "lk_lang";

/** Cookie first (explicit choice), then the browser's language. Hebrew browsers → he, everyone else → en. */
export async function getLocale(): Promise<Locale> {
  const c = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (c === "he" || c === "en") return c;
  const al = ((await headers()).get("accept-language") ?? "").toLowerCase();
  return /(^|,)\s*(he|iw)\b/.test(al) ? "he" : "en";
}

export async function getT(): Promise<{ t: Dict; locale: Locale; dir: "rtl" | "ltr" }> {
  const locale = await getLocale();
  return { t: locale === "en" ? en : he, locale, dir: locale === "he" ? "rtl" : "ltr" };
}
