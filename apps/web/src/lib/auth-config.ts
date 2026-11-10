/**
 * Turn on only after the Supabase "Magic Link" e-mail template includes the 6-digit code ({{ .Token }}).
 * Then the "check your email" screen also accepts the code, which is what makes sign-in work inside an
 * iPhone home-screen app (it does not share Safari's cookies, so a link opened from Mail logs in Safari instead).
 */
export const LOGIN_EMAIL_HAS_CODE = false;
