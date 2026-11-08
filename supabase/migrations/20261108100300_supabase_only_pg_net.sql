-- Supabase-only: outbound HTTP from the database, used for live end-to-end checks of the woo Edge Function.
create extension if not exists pg_net with schema extensions;
