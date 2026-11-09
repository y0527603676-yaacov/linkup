import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";

/**
 * Same-origin copy of a synced product image so the story maker can draw it on a canvas.
 * Only images of products the signed-in user may read (RLS), only https, only images, max 5 MB. Not an open proxy.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new NextResponse(null, { status: 404 });
  const sb = await getSupabase();
  const { data } = await sb.from("products").select("image_url").eq("id", id).maybeSingle();
  const url = data?.image_url;
  if (!url || !url.startsWith("https://")) return new NextResponse(null, { status: 404 });
  try {
    const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(8000) });
    const type = r.headers.get("content-type") ?? "";
    const len = Number(r.headers.get("content-length") ?? 0);
    if (!r.ok || !type.startsWith("image/") || len > 5_000_000) return new NextResponse(null, { status: 404 });
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 5_000_000) return new NextResponse(null, { status: 404 });
    return new NextResponse(buf, { headers: { "Content-Type": type, "Cache-Control": "private, max-age=3600" } });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
