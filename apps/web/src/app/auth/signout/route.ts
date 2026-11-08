import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  const sb = await getSupabase();
  await sb.auth.signOut();
  const dest = req.nextUrl.clone();
  dest.pathname = "/";
  dest.search = "";
  return NextResponse.redirect(dest, { status: 303 });
}
