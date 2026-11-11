import type { Metadata } from "next";
import { PublicPage } from "@/components/Site";
import { getT } from "@/i18n";
import { SUPABASE_URL } from "@/lib/supabase/env";

export const metadata: Metadata = { title: "LINKUP API – developer guide" };

/** Developer guide for custom sites: the same signed endpoint and order format the WooCommerce plugin uses. */
export default async function Developers() {
  const { locale } = await getT();
  const he = locale === "he";
  const endpoint = `${SUPABASE_URL}/functions/v1/woo`;
  const T = he ? HE : EN;
  const Code = ({ children }: { children: string }) => <pre className="card card-flat small" dir="ltr" style={{ overflowX: "auto", whiteSpace: "pre", margin: 0 }}>{children}</pre>;
  return (
    <PublicPage path="/developers">
      <section className="container stack" style={{ padding: "40px 16px 80px", maxWidth: 820 }}>
        <h1>{T.title}</h1>
        <p className="muted">{T.lead}</p>
        <p className="alert alert-warn small">{T.trust}</p>

        <h2>{T.s1}</h2>
        <ul>{T.key.map((x) => <li key={x}>{x}</li>)}</ul>

        <h2>{T.s2}</h2>
        <p>{T.req}</p>
        <Code>{`POST ${endpoint}
Content-Type: application/json
X-LinkUp-Connection: <connection_id>
X-LinkUp-Timestamp:  <unix seconds>
X-LinkUp-Signature:  hex( HMAC-SHA256( secret, "<timestamp>.<raw body>" ) )`}</Code>
        <p className="small muted">{T.skew}</p>

        <h2>{T.s3}</h2>
        <p>{T.sync}</p>
        <Code>{`{"action":"sync","plugin_version":"my-site 1.0"}
→ 200 {"ok":true,"result":{"server_time":"…","coupons":[{"code":"NOA10","discount_pct":10,"active":true}]}}`}</Code>

        <h2>{T.s4}</h2>
        <p>{T.event}</p>
        <Code>{`{"action":"event","event":{
  "event_id": "order-1042-v3",              // unique per change; the same id twice is ignored
  "type": "order.upserted",
  "occurred_at": "2026-11-11T09:30:00Z",
  "order": {
    "id": "1042",                            // your order id (unique in your store)
    "status": "completed",                   // pending | processing | on-hold | completed | cancelled | refunded | failed
    "currency": "ILS",
    "total": 24600,                          // minor units (agorot), incl. VAT and shipping
    "tax": 0, "shipping": 1000, "shipping_tax": 0,
    "coupons": ["NOA10"],
    "ref": "NOA10|1762851000",               // optional: lku value + visit time (see below)
    "email_hash": "<sha256 of lower-case e-mail>",  // optional, only to detect self-referrals
    "created_at": "2026-11-11T09:20:00Z",
    "refunds": [{"id":"r1","amount":5900}]   // every refund so far (send the full list each time)
  }}}`}</Code>
        <ul className="small">{T.eventNotes.map((x) => <li key={x}>{x}</li>)}</ul>

        <h2>{T.s5}</h2>
        <p>{T.products}</p>
        <Code>{`{"action":"products","products":[
  {"id":"88","name":"Silver ring","url":"https://shop.example/p/88","image":"https://…/88.jpg",
   "price":24900,"currency":"ILS","in_stock":true,"stock_qty":12,"categories":["Rings"],"status":"publish"}]}`}</Code>

        <h2>{T.s6}</h2>
        <ul>{T.ref.map((x) => <li key={x}>{x}</li>)}</ul>

        <h2>{T.s7}</h2>
        <Code>{`200 {"ok":true,...}                          ${T.r200}
401 {"error":"unauthorized"}                  ${T.r401}
422 {"error":"invalid_event" | "connection_disconnected"}   ${T.r422}
503 {"error":"temporary_error"}               ${T.r503}`}</Code>

        <h2>{T.s8}</h2>
        <Code>{`// Node.js 18+
import crypto from "node:crypto";
const [, id, secret] = process.env.LINKUP_KEY.match(/^lk_([0-9a-f]{32})_(.+)$/);
async function linkup(body) {
  const raw = JSON.stringify(body), ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", secret).update(\`\${ts}.\${raw}\`).digest("hex");
  const r = await fetch("${endpoint}", { method: "POST", body: raw, headers: {
    "Content-Type": "application/json", "X-LinkUp-Connection": id, "X-LinkUp-Timestamp": String(ts), "X-LinkUp-Signature": sig } });
  return r.json();
}
await linkup({ action: "sync", plugin_version: "my-site 1.0" });   // ${T.check}`}</Code>
        <Code>{`<?php // PHP 7.4+
preg_match('/^lk_([0-9a-f]{32})_(.+)$/', getenv('LINKUP_KEY'), $m);
$raw = json_encode(['action' => 'sync', 'plugin_version' => 'my-site 1.0']);
$ts  = time();
$sig = hash_hmac('sha256', $ts . '.' . $raw, $m[2]);
$ch  = curl_init('${endpoint}');
curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $raw, CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['Content-Type: application/json', "X-LinkUp-Connection: {$m[1]}", "X-LinkUp-Timestamp: $ts", "X-LinkUp-Signature: $sig"]]);
echo curl_exec($ch);`}</Code>

        <h2>{T.s9}</h2>
        <ol>{T.test.map((x) => <li key={x}>{x}</li>)}</ol>
        <h2>{T.s10}</h2>
        <ul>{T.sec.map((x) => <li key={x}>{x}</li>)}</ul>
      </section>
    </PublicPage>
  );
}

const HE = {
  title: "LINKUP API: מדריך למתכנת", lead: "חיבור אתר מותאם אישית ל-LINKUP: דיווח חתום על הזמנות, ביטולים, החזרים ומוצרים. זה אותו ממשק שהתוסף של WooCommerce משתמש בו.",
  trust: "חתימה מאמתת שהדיווח הגיע מהאתר של החנות ושלא שונה בדרך. היא לא מאמתת את העסקה מול חברת הסליקה. עמלות נוצרות רק מדיווח על הזמנה, אף פעם לא מביקור או מקליק בלבד.",
  s1: "1. מפתח החיבור", key: ["בעל החנות יוצר מפתח ב-LINKUP: חיבור החנות ← \"יש לי מתכנת לאתר\".", "המבנה: lk_<מזהה חיבור, 32 תווים>_<סוד>. המזהה נשלח בכותרת, והסוד משמש רק לחתימה ולא נשלח אף פעם.", "שמרו את המפתח בצד השרת בלבד, למשל במשתנה סביבה. לעולם לא בקוד שרץ בדפדפן."],
  s2: "2. כל בקשה", req: "בקשת POST עם גוף JSON ושלוש כותרות:", skew: "החתימה תקפה 5 דקות סביב שעון השרת, ולכן שעון השרת שלכם צריך להיות מסונכרן.",
  s3: "3. בדיקת חיבור וקופונים (sync)", sync: "הקריאה הראשונה מסמנת ב-LINKUP שהאתר מחובר. התשובה כוללת את קופוני המשפיענים שצריכים להיות פעילים באתר. כדאי לקרוא לה פעם בשעה וליצור, להפעיל או לכבות את הקופונים בהתאם.",
  s4: "4. דיווח על הזמנה (event)", event: "שלחו דיווח בכל שינוי בהזמנה: יצירה, תשלום, השלמה, ביטול או החזר. כל דיווח מכיל את מצב ההזמנה המלא באותו רגע.",
  eventNotes: ["כל הסכומים ביחידות קטנות (אגורות), מספרים שלמים.", "event_id ייחודי לכל שינוי. אותו event_id פעמיים נקלט פעם אחת בלבד.", "הזמנה מזוהה לפי id. דיווח חדש על אותה הזמנה מעדכן אותה, לא יוצר כפילות.", "אם המחירים כוללים מע״מ ואין לכם פירוט מס, שלחו tax: 0, ו-LINKUP תנכה מע״מ לפי הגדרת החנות.", "ביטול: status \"cancelled\". החזר: הוסיפו את ההחזר לרשימת refunds. העמלה מתעדכנת אוטומטית.", "עמלה עוברת לאישור רק אחרי חלון ההחזרות של החנות."],
  s5: "5. מוצרים (products, לא חובה)", products: "סנכרון מוצרים מאפשר למשפיענים לבחור מה לקדם. המחירים ביחידות קטנות.",
  s6: "6. ייחוס לפי קישור (לא חובה)", ref: ["קישור של משפיען מגיע לאתר עם הפרמטר lku=CODE.", "שמרו את הקוד ואת זמן הביקור (שניות) בעוגייה מצד ראשון ל-30 יום, בכפוף להסכמה לעוגיות.", "בהזמנה שלחו ref בפורמט CODE|unix-seconds. קופון קודם לקישור."],
  s7: "7. תשובות", r200: "נקלט", r401: "חתימה, מזהה או שעון שגויים", r422: "לא לשלוח שוב", r503: "לנסות שוב מאוחר יותר",
  s8: "8. דוגמאות", check: "בדיקת חיבור",
  s9: "9. בדיקה לפני עלייה לאוויר", test: ["הריצו sync. במסך של בעל החנות ב-LINKUP הסטטוס יתחלף ל\"מחובר\".", "שלחו הזמנת בדיקה בלי קופון של משפיען. היא תיקלט בלי עמלה.", "שלחו את אותו דיווח פעמיים, וודאו שהתשובה השנייה היא duplicate.", "בדקו ביטול והחזר על הזמנת הבדיקה."],
  s10: "10. אבטחה", sec: ["אם המפתח נחשף, בעל החנות יוצר מפתח חדש ב-LINKUP, והקודם מפסיק לעבוד מיד.", "ניתוק החנות ב-LINKUP חוסם כל דיווח נוסף (connection_disconnected).", "לא שולחים שמות, כתובות, טלפונים או פרטי תשלום של לקוחות."],
};
const EN: typeof HE = {
  title: "LINKUP API: developer guide", lead: "Connect a custom site to LINKUP: signed reports of orders, cancellations, refunds and products – the same interface the WooCommerce plugin uses.",
  trust: "A signature proves the report came from the store's site unchanged. It does not verify the transaction with the payment provider. Commissions come only from order reports, never from a visit or click alone.",
  s1: "1. Connection key", key: ["The store owner creates a key in LINKUP: Connect store → \"I have a developer\".", "Format: lk_<connection id, 32 chars>_<secret>. The id goes in a header; the secret only signs and is never sent.", "Keep the key server-side only (e.g. an environment variable), never in browser code."],
  s2: "2. Every request", req: "POST with a JSON body and three headers:", skew: "Signatures are valid for 5 minutes around server time, so keep your server clock in sync.",
  s3: "3. Connection check and coupons (sync)", sync: "The first call marks the site as connected in LINKUP. The answer lists the creator coupons that should be active on your site; call it hourly and create, enable or disable coupons accordingly.",
  s4: "4. Order report (event)", event: "Send a report on every order change (created, paid, completed, cancelled, refunded) with the full order state at that moment.",
  eventNotes: ["All amounts in minor units (agorot), integers.", "event_id is unique per change; the same event_id twice is processed once.", "Orders are identified by id; a new report for the same order updates it, never duplicates it.", "If prices include VAT and you have no tax breakdown, send tax: 0 and LINKUP deducts VAT per the store's setting.", "Cancellation: status \"cancelled\". Refund: add it to refunds. The commission updates automatically.", "A commission is approved only after the store's refund window."],
  s5: "5. Products (products, optional)", products: "Product sync lets creators choose what to promote. Prices in minor units.",
  s6: "6. Link attribution (optional)", ref: ["A creator link reaches your site with lku=CODE.", "Keep the code and visit time (seconds) in a first-party cookie for 30 days, subject to cookie consent.", "On the order, send ref as CODE|unix-seconds. A coupon wins over a link."],
  s7: "7. Responses", r200: "accepted", r401: "wrong signature, id or clock", r422: "do not retry", r503: "retry later",
  s8: "8. Examples", check: "connection check",
  s9: "9. Before going live", test: ["Run sync: the owner's LINKUP screen turns to \"Connected\".", "Send a test order without a creator coupon: it is recorded with no commission.", "Send the same report twice and check the second answer is duplicate.", "Test a cancellation and a refund on the test order."],
  s10: "10. Security", sec: ["If the key leaks, the owner creates a new one in LINKUP and the old one stops working at once.", "Disconnecting the store in LINKUP blocks further reports (connection_disconnected).", "Never send customer names, addresses, phone numbers or payment details."],
};
