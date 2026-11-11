import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";
import { partnerDestination, type ResolvedLink } from "@/lib/partner-link";

/** Creator's personal link: /r/CODE → the store (see lib/partner-link for how each platform keeps the attribution). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const home = new URL("/", req.url);
  if (!/^[A-Za-z0-9]{4,16}$/.test(code)) return NextResponse.redirect(home);
  const sb = await getSupabase();
  const { data } = await sb.rpc("resolve_partner_link", { p_code: code });
  const dest = data ? partnerDestination(data as ResolvedLink) : null;
  if (!dest) return NextResponse.redirect(home);
  return NextResponse.redirect(dest, { status: 302 });
}
