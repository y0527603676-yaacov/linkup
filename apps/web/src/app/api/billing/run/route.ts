import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { billingProviders, runBilling } from "@/lib/payments";

/**
 * Billing worker endpoint for a scheduler (cron). Needs BILLING_CRON_SECRET and the service key in server env.
 * With the master switch (auto_collection_enabled) off in the database, a run schedules and charges nothing.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.BILLING_CRON_SECRET, key = process.env.SUPABASE_SERVICE_ROLE_KEY, url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!secret || !key || !url) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const rpc = async <T,>(fn: string, args: Record<string, unknown> = {}) => {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  };
  const { pay, docs } = billingProviders();
  const report = await runBilling(rpc, pay, docs);
  return NextResponse.json(report);
}
