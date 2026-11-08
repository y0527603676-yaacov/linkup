import Link from "next/link";

export default function Home() {
  return (
    <main className="wrap">
      <span className="logo">LINKUP</span>
      <h1>משפיענים שמביאים מכירות. עמלה רק על מה שנמכר.</h1>
      <p className="lead">
        מחברים את חנות ה-WooCommerce, שולחים הצעה למשפיען בוואטסאפ, וכל מכירה מהקופון או מהקישור שלו נספרת אוטומטית.
      </p>
      <Link className="btn btn-primary btn-block" href="/login?next=/app">התחילו בחינם</Link>
      <p className="note">בלי מנוי. LINKUP גובה עמלה קטנה רק ממכירות שהגיעו דרך שותפים.</p>
      <ol className="how">
        <li><b>חנות</b> מחברת את האתר ושולחת הצעה למשפיען</li>
        <li><b>משפיען</b> מאשר בלחיצה ומקבל קופון וקישור אישיים</li>
        <li><b>כל מכירה</b> נספרת, כולל החזרות, והעמלה מחושבת לבד</li>
      </ol>
    </main>
  );
}
