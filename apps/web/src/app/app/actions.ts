"use server";
import { redirect } from "next/navigation";
import { getSupabase } from "@/lib/supabase/server";
import { errorCode, safeNext } from "@/lib/format";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const pctToBps = (v: string, fallback: number) => {
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) : fallback;
};

export async function createOrg(form: FormData) {
  const type = str(form, "type");
  const next = str(form, "next");
  const sb = await getSupabase();
  const { data, error } = await sb.rpc("create_organization", {
    p_type: type, p_name: str(form, "name"), p_website_url: str(form, "website") || null,
  });
  if (error) redirect(`/app/new?error=${errorCode(error)}&type=${encodeURIComponent(type)}&next=${encodeURIComponent(next)}`);
  if (next) redirect(safeNext(next));
  redirect(type === "store" ? `/app/connect?org=${data}` : `/app?org=${data}`);
}

export type ConnectState = { error?: string; key?: string; site?: string };

export async function connectStore(_prev: ConnectState, form: FormData): Promise<ConnectState> {
  const sb = await getSupabase();
  const { data, error } = await sb.rpc("create_store_connection", { p_org: str(form, "org"), p_site_url: str(form, "site") });
  if (error) return { error: errorCode(error) };
  const r = data as { connection_key: string; site_url: string };
  return { key: r.connection_key, site: r.site_url };
}

export async function createInvite(form: FormData) {
  const org = str(form, "org");
  const sb = await getSupabase();
  const { data, error } = await sb.rpc("create_proposal", {
    p_from_org: org,
    p_commission_bps: pctToBps(str(form, "commission"), 1000),
    p_invitee_name: str(form, "name") || null,
    p_invitee_contact: str(form, "contact") || null,
    p_coupon_discount_pct: form.has("discount") ? Math.round(Number(str(form, "discount")) || 0) : null,
    p_attribution_days: null,
    p_target_site_url: str(form, "site") || null,
    p_source_proposal: str(form, "source") || null,
  });
  if (error) redirect(`/app/invite?org=${org}&error=${errorCode(error)}`);
  const r = data as { token: string };
  redirect(`/app/invite/sent?org=${org}&token=${r.token}&name=${encodeURIComponent(str(form, "name"))}`);
}

export async function acceptOffer(form: FormData) {
  const token = str(form, "token");
  let org = str(form, "org");
  const sb = await getSupabase();
  if (!org) {
    const { data, error } = await sb.rpc("create_organization", {
      p_type: str(form, "type"), p_name: str(form, "name"), p_website_url: str(form, "website") || null,
    });
    if (error) redirect(`/o/${token}?error=${errorCode(error)}`);
    org = data as string;
  }
  const { error } = await sb.rpc("accept_proposal", { p_token: token, p_org: org });
  if (error) redirect(`/o/${token}?error=${errorCode(error)}`);
  redirect(`/app?org=${org}&accepted=1`);
}
