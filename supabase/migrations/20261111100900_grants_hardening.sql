-- LINKUP — remove grants Supabase adds by default to new objects (found when comparing production with the rehearsal).
-- Access was already blocked (admin checks inside the functions; RLS with no policies on the tables); this removes the
-- grants themselves. Tables are reached only through security-definer functions.
revoke execute on function public.admin_contact_messages(), public.mark_contact_handled(uuid) from anon;
revoke all on public.billing_alerts, public.lookup_attempts from anon, authenticated;
