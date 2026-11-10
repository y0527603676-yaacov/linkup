"use server";
import { redirect } from "next/navigation";
import { getOrigin, getSupabase } from "@/lib/supabase/server";
import { safeNext } from "@/lib/format";

export async function sendLink(form: FormData) {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const next = safeNext(form.get("next"));
  const resend = form.get("resend") === "1";
  const sentQs = `sent=1&email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    redirect(`/login?error=email&next=${encodeURIComponent(next)}`);
  }
  const sb = await getSupabase();
  const origin = await getOrigin();
  // Public sign-up stays closed until the sign-in e-mail test passes (set LINKUP_SIGNUPS_OPEN=true in Vercel).
  // Until then only existing accounts can log in.
  const open = process.env.LINKUP_SIGNUPS_OPEN === "true";
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: open, emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}` },
  });
  if (error) {
    const closed = !open && /signups? not allowed|not found|otp_disabled/i.test(`${error.message} ${(error as { code?: string }).code ?? ""}`);
    const code = closed ? "signups_closed" : "send_failed";
    redirect(resend ? `/login?${sentQs}&error=${code}` : `/login?error=${code}&next=${encodeURIComponent(next)}`);
  }
  redirect(`/login?${sentQs}${resend ? "&resent=1" : ""}`);
}
