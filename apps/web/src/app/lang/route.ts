import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/lib/format";

/** /lang?to=en&next=/stores — remembers the visitor's language choice for a year. */
export function GET(req: NextRequest) {
  const to = req.nextUrl.searchParams.get("to") === "en" ? "en" : "he";
  const dest = new URL(safeNext(req.nextUrl.searchParams.get("next"), "/"), req.url);
  const res = NextResponse.redirect(dest);
  res.cookies.set("lk_lang", to, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  return res;
}
