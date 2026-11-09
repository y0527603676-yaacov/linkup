"use client";
import { useState } from "react";

export function CopyButton({ text, label, done = "✓", className = "btn btn-ghost btn-sm", onCopied }: {
  text: string; label: string; done?: string; className?: string; onCopied?: () => void;
}) {
  const [ok, setOk] = useState(false);
  return (
    <button type="button" className={className} onClick={async () => {
      try { await navigator.clipboard.writeText(text); } catch { window.prompt("", text); }
      setOk(true); onCopied?.(); setTimeout(() => setOk(false), 1800);
    }}>{ok ? done : label}</button>
  );
}
