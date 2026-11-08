import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";

/** Partner link: /r/CODE → store site with ?lku=CODE (the plugin stores a first-party cookie). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const home = new URL("/", req.url);
  if (!/^[A-Za-z0-9]{4,16}$/.test(code)) return NextResponse.redirect(home);
  const sb = await getSupabase();
  const { data } = await sb.rpc("resolve_partner_link", { p_code: code });
  const r = data as { code: string; url: string | null } | null;
  if (!r?.url) return NextResponse.redirect(home);
  const dest = new URL(r.url);
  dest.searchParams.set("lku", r.code);
  return NextResponse.redirect(dest, { status: 302 });
}
