import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";

/** Transfer proof download — only for the store and the creator of that payment (enforced in the database). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await getSupabase();
  const { data, error } = await sb.rpc("get_payout_proof", { p_proof: id });
  if (error || !data) return new NextResponse("forbidden", { status: 403 });
  const f = data as { filename: string; mime: string; base64: string };
  return new NextResponse(Buffer.from(f.base64, "base64"), { headers: { "content-type": f.mime,
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(f.filename)}`, "x-content-type-options": "nosniff" } });
}
