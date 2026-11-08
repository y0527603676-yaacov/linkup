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
  const code = p.get("code");
  const tokenHash = p.get("token_hash");
  if (code) ok = !(await sb.auth.exchangeCodeForSession(code)).error;
  else if (tokenHash) ok = !(await sb.auth.verifyOtp({ token_hash: tokenHash, type: (p.get("type") ?? "email") as EmailOtpType })).error;
  const dest = req.nextUrl.clone();
  dest.search = "";
  if (ok) {
    const [path, query] = next.split("?");
    dest.pathname = path ?? "/app";
    dest.search = query ? `?${query}` : "";
  } else {
    dest.pathname = "/login";
    dest.search = `?error=bad_code&next=${encodeURIComponent(next)}`;
  }
  return NextResponse.redirect(dest);
}
