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
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}` },
  });
  if (error) redirect(`/login?error=send_failed&next=${encodeURIComponent(next)}`);
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
