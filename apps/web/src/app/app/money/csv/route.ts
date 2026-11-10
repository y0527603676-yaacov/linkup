import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";

const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

/** CSV of a store–creator statement (lines and payments). Same access rule as the statement itself. */
export async function GET(req: NextRequest) {
  const org = req.nextUrl.searchParams.get("org"), other = req.nextUrl.searchParams.get("with");
  if (!org || !other) return new NextResponse("bad request", { status: 400 });
  const sb = await getSupabase();
  const { data: o } = await sb.from("organizations").select("type").eq("id", org).single();
  if (!o) return new NextResponse("forbidden", { status: 403 });
  const [store, creator] = o.type === "store" ? [org, other] : [other, org];
  const { data, error } = await sb.rpc("creator_statement", { p_store: store, p_creator: creator });
  if (error || !data) return new NextResponse("forbidden", { status: 403 });
  const s = data as any;
  const rows = [["kind", "date", "order", "type", "base", "rate_pct", "amount", "vat", "withholding", "net_transferred", "status", "reference"].map(cell).join(",")];
  for (const l of s.lines) rows.push(["line", l.date, l.order, l.type, l.base_minor / 100, l.rate_bps / 100, l.amount_minor / 100, "", "", "", l.state, ""].map(cell).join(","));
  for (const p of s.payments) rows.push(["payment", p.paid_on ?? p.reported_at, "", p.method, "", "", p.amount_minor / 100, p.tax_basis === "undetermined" ? "pending_tax_review" : p.vat_minor / 100, (p.withholding_minor ?? 0) / 100, (p.net_minor ?? p.amount_minor) / 100, p.status, p.reference ?? ""].map(cell).join(","));
  return new NextResponse("﻿" + rows.join("\n"), { headers: { "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="linkup-statement-${new Date().toISOString().slice(0, 10)}.csv"` } });
}
