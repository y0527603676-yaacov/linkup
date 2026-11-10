"use client";
import type { ReactNode } from "react";

/**
 * A submit button that carries a choice (name=value). Server-action form submissions do not reliably include the
 * clicked button, so the choice is also written into a hidden field of the same form just before it submits.
 * Without JavaScript the browser's native submission includes the button's own name/value.
 */
export function ChoiceButton({ name, value, className, children }: { name: string; value: string; className?: string; children: ReactNode }) {
  return (
    <button type="submit" name={name} value={value} className={className} onClick={(e) => {
      const form = e.currentTarget.form;
      if (!form) return;
      let h = form.querySelector<HTMLInputElement>(`input[type="hidden"][data-choice="${name}"]`);
      if (!h) { h = document.createElement("input"); h.type = "hidden"; h.name = name; h.dataset.choice = name; form.appendChild(h); }
      h.value = value;
    }}>{children}</button>
  );
}
