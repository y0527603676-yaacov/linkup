import { NextResponse } from "next/server";
import { verifySignature } from "@/domains/integrations/woocommerce/signature";

/**
 * Phase 0 skeleton. Phase 1 (task 1.7) adds:
 *  - lookup of store connection + secret by X-Linkup-Connection header
 *  - INSERT into order_events ON CONFLICT DO NOTHING (idempotent inbox)
 *  - enqueue processing job; respond 200 immediately
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const sig = req.headers.get("x-linkup-signature") ?? "";
  const ts = Number(req.headers.get("x-linkup-timestamp"));
  const secret = process.env.LINKUP_DEV_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (!verifySignature(raw, sig, ts, secret, Math.floor(Date.now() / 1000))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ received: true });
}
