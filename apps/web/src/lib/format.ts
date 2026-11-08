export function money(minor: number | null | undefined, currency = "ILS"): string {
  return new Intl.NumberFormat("he-IL", { style: "currency", currency, maximumFractionDigits: 2 }).format((minor ?? 0) / 100);
}

export const pct = (bps: number) => `${(bps / 100).toLocaleString("he-IL", { maximumFractionDigits: 2 })}%`;

export const date = (iso: string) => new Date(iso).toLocaleDateString("he-IL", { day: "numeric", month: "numeric", year: "2-digit" });

const ERRORS: Record<string, string> = {
  forbidden: "אין לך הרשאה לפעולה הזו.",
  not_authenticated: "צריך להתחבר כדי להמשיך.",
  invalid_url: "כתובת האתר לא תקינה. לדוגמה: myshop.co.il",
  invalid_name: "השם קצר מדי.",
  invalid_type: "סוג חשבון לא תקין.",
  proposal_closed: "ההצעה הזו כבר אושרה או נדחתה.",
  proposal_expired: "תוקף ההצעה פג. בקשו מהשולח הצעה חדשה.",
  wrong_org_type: "ההצעה מיועדת לסוג חשבון אחר.",
  rate_limited: "הגעתם למגבלת ההצעות היומית. נסו שוב מחר.",
  not_found: "ההצעה לא נמצאה.",
  too_many_orgs: "הגעתם למספר החשבונות המרבי.",
  unsupported_org_type: "סוכנויות יוכלו לשלוח הצעות בשלב הבא.",
  not_a_store: "רק חשבון חנות יכול לחבר אתר.",
  bad_code: "הקוד שגוי או שפג תוקפו. בקשו קוד חדש.",
  email: "כתובת המייל לא תקינה.",
  send_failed: "לא הצלחנו לשלוח מייל כרגע. נסו שוב בעוד דקה.",
};

export function errorText(code: string | undefined | null): string | null {
  if (!code) return null;
  return ERRORS[code] ?? "משהו השתבש. נסו שוב.";
}

/** Map a Supabase/PostgREST error to our short code. */
export function errorCode(err: { message?: string } | null | undefined): string {
  const m = err?.message ?? "";
  return Object.prototype.hasOwnProperty.call(ERRORS, m) ? m : "unknown";
}

/** Only allow same-site relative redirects. */
export function safeNext(next: unknown, fallback = "/app"): string {
  const s = typeof next === "string" ? next : "";
  return s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\") ? s : fallback;
}

export const ORG_LABEL: Record<string, string> = { store: "חנות", creator: "משפיען/ית", agency: "סוכנות" };
