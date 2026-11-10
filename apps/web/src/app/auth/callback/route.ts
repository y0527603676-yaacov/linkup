import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase/server";
import { safeNext } from "@/lib/format";

/** Handles both the default PKCE link (?code=) and a token-hash link (?token_hash=&type=) that works across browsers. */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const next = safeNext(p.get("next"));
  const sb = await getSupabase();
  let ok = false;
  let reason = "bad_code";
  const code = p.get("code");
  const tokenHash = p.get("token_hash");
  if (code) {
    const { error } = await sb.auth.exchangeCodeForSession(code);
    ok = !error;
    // The default link only works in the browser that asked for it; say so instead of "invalid link".
    if (error && /verifier/i.test(`${(error as { code?: string }).code ?? ""} ${error.message}`)) reason = "link_other_browser";
  }
  else if (tokenHash) ok = !(await sb.auth.verifyOtp({ token_hash: tokenHash, type: (p.get("type") ?? "email") as EmailOtpType })).error;
  const dest = req.nextUrl.clone();
  dest.search = "";
  if (ok) {
    const [path, query] = next.split("?");
    dest.pathname = path ?? "/app";
    dest.search = query ? `?${query}` : "";
  } else {
    dest.pathname = "/login";
    dest.search = `?error=${reason}&next=${encodeURIComponent(next)}`;
  }
  return NextResponse.redirect(dest);
}
