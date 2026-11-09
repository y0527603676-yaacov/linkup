import { NextResponse, type NextRequest } from "next/server";

/** Personal referral link /join/CODE → remembers the referrer for 30 days, then the matching landing page. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const to = req.nextUrl.searchParams.get("to");
  const dest = new URL(to === "store" ? "/stores" : to === "creator" ? "/creators" : "/", req.url);
  const res = NextResponse.redirect(dest);
  if (/^[A-Za-z0-9]{6,12}$/.test(code)) {
    res.cookies.set("lk_ref", code.toUpperCase(), { path: "/", maxAge: 60 * 60 * 24 * 30, sameSite: "lax", httpOnly: true });
  }
  return res;
}
