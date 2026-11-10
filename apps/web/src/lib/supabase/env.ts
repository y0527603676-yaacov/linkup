// Public, browser-safe values for the LINKUP Supabase project (not secrets).
// Env vars override them; the defaults keep the app working if a deploy is missing them.
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://ycuvcpslvkgndytubycn.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "sb_publishable_l9jf_WeuH8ZAmSlQE8qfIw_mgwQ_QL9";

/**
 * Session cookies: kept 400 days (renewed on use by the middleware's refresh), readable by the server only (httpOnly),
 * sent over HTTPS only in production. The app has no browser-side Supabase client, so scripts never need the tokens.
 */
export const AUTH_COOKIE = {
  path: "/", sameSite: "lax" as const, httpOnly: true, secure: process.env.NODE_ENV === "production" && !process.env.LINKUP_LOCAL_HTTP,
  maxAge: 400 * 24 * 60 * 60,
};
