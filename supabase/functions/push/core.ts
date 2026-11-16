// Builds the push message for a sale notification. Pure (no I/O) so it can be tested.
export type Pending = {
  id: string; kind: "sale" | "first_sale"; org_id: string; org_type: "store" | "creator"; locale: string;
  payload: { partner?: string; store?: string; order_id?: string };
  currency: string | null; order_minor: number | null; commission_minor: number | null;
  devices: { endpoint: string; p256dh: string; auth: string }[];
};
export type Message = { title: string; body: string; url: string; tag: string };

const money = (minor: number | null, currency: string | null, locale: string) => {
  if (minor == null || !currency) return "";
  try {
    return new Intl.NumberFormat(locale === "en" ? "en-US" : "he-IL", { style: "currency", currency }).format(minor / 100);
  } catch { return `${(minor / 100).toFixed(2)} ${currency}`; }
};

export function buildMessage(n: Pending): Message {
  const en = n.locale === "en";
  const first = n.kind === "first_sale";
  const url = `/app/notifications?org=${n.org_id}`;
  const tag = `sale-${n.payload.order_id ?? n.id}`;
  if (n.org_type === "store") {
    const partner = n.payload.partner ?? (en ? "a partner" : "שותף");
    const amount = money(n.order_minor, n.currency, n.locale);
    return en
      ? { title: first ? "🎉 Your first sale through LINKUP!" : `New sale through ${partner} 🎉`,
          body: `${first ? `${partner} brought an order` : "An order"}${amount ? ` of ${amount}` : ""}. The commission is recorded and approved after the return window.`, url, tag }
      : { title: first ? "🎉 המכירה הראשונה שלכם דרך LINKUP!" : `מכירה חדשה דרך ${partner} 🎉`,
          body: `${first ? `${partner} הביא/ה הזמנה` : "הזמנה"}${amount ? ` בסך ${amount}` : ""}. העמלה נרשמה ותאושר אחרי חלון ההחזרות.`, url, tag };
  }
  const store = n.payload.store ?? (en ? "a store" : "חנות");
  const commission = money(n.commission_minor, n.currency, n.locale);
  return en
    ? { title: first ? "🎉 Your first sale!" : `New sale at ${store} 🎉`,
        body: `${first ? `${store}: ` : ""}${commission ? `you earned ${commission} in commission` : "a commission was recorded"}. It is approved after the return window.`, url, tag }
    : { title: first ? "🎉 המכירה הראשונה שלכם!" : `מכירה חדשה ב-${store} 🎉`,
        body: `${first ? `${store}: ` : ""}${commission ? `הרווחתם עמלה של ${commission}` : "נרשמה עמלה"}. היא תאושר אחרי חלון ההחזרות.`, url, tag };
}
