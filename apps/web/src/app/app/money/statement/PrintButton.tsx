"use client";
export function PrintButton({ label }: { label: string }) {
  return <button type="button" className="btn btn-primary btn-sm" onClick={() => window.print()}>{label}</button>;
}
