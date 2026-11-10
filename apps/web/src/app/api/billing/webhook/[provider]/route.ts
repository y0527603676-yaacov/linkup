import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { billingProviders } from "@/lib/payments";

/** Provider webhooks: signature checked by the adapter, each event stored once (duplicates are acknowledged and ignored). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const { name, pay } = billingProviders();
  if (provider !== name) return NextResponse.json({ error: "unknown_provider" }, { status: 404 });
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY, url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!key || !url) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const raw = await req.text();
  const ev = await pay.parseWebhook(req.headers, raw).catch(() => null);
  if (!ev) return NextResponse.json({ error: "bad_signature" }, { status: 401 });
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await sb.rpc("billing_record_webhook", { p_provider: name, p_event_id: ev.eventId, p_kind: ev.kind, p_payload: ev.payload });
  if (error) return NextResponse.json({ error: "store_failed" }, { status: 500 });
  return NextResponse.json({ ok: true, status: data });
}
