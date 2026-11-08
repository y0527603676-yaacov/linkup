"use client";
import { useState } from "react";

export function CopyButton({ text, label = "העתקה" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1800);
        } catch {
          window.prompt("העתיקו:", text);
        }
      }}
    >
      {done ? "הועתק ✓" : label}
    </button>
  );
}
