// Public, browser-safe values for the LINKUP Supabase project (not secrets).
// Env vars override them; the defaults keep the app working if a deploy is missing them.
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://ycuvcpslvkgndytubycn.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "sb_publishable_l9jf_WeuH8ZAmSlQE8qfIw_mgwQ_QL9";
