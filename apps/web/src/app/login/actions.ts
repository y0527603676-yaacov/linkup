"use server";
import { redirect } from "next/navigation";
import { getOrigin, getSupabase } from "@/lib/supabase/server";
import { safeNext } from "@/lib/format";

export async function sendLink(form: FormData) {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const next = safeNext(form.get("next"));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    redirect(`/login?error=email&next=${encodeURIComponent(next)}`);
  }
  const sb = await getSupabase();
  const origin = await getOrigin();
  // Public sign-up stays closed until the login-code e-mail test passes (set LINKUP_SIGNUPS_OPEN=true in Vercel).
  // Until then only existing accounts can log in.
  const open = process.env.LINKUP_SIGNUPS_OPEN === "true";
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: open, emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}` },
  });
  if (error) {
    const closed = !open && /signups? not allowed|not found|otp_disabled/i.test(`${error.message} ${(error as { code?: string }).code ?? ""}`);
    redirect(`/login?error=${closed ? "signups_closed" : "send_failed"}&next=${encodeURIComponent(next)}`);
  }
  redirect(`/login?sent=1&email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`);
}

export async function verifyCode(form: FormData) {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const token = String(form.get("code") ?? "").trim();
  const next = safeNext(form.get("next"));
  const sb = await getSupabase();
  const { error } = await sb.auth.verifyOtp({ email, token, type: "email" });
  if (error) redirect(`/login?sent=1&email=${encodeURIComponent(email)}&error=bad_code&next=${encodeURIComponent(next)}`);
  redirect(next);
}
