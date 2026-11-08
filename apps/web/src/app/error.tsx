"use client";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="wrap">
      <span className="logo">LINKUP</span>
      <h1>משהו השתבש</h1>
      <p className="lead">נסו שוב. אם זה חוזר, שלחו לנו את הקוד: <bdi dir="ltr">{error.digest ?? "—"}</bdi></p>
      <button className="btn btn-primary btn-block" onClick={() => reset()}>נסו שוב</button>
      <p className="note"><a href="/">לדף הבית</a></p>
    </main>
  );
}
