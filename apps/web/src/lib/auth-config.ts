/**
 * On: the Supabase "Magic Link" template includes the code ({{ .Token }}) since 2026-11-10 (confirmed by the owner).
 * Then the "check your email" screen also accepts the code, which is what makes sign-in work inside an
 * iPhone home-screen app (it does not share Safari's cookies, so a link opened from Mail logs in Safari instead).
 */
export const LOGIN_EMAIL_HAS_CODE = true;
