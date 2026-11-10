"use client";
import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * Instant feedback while the server works: a thin top bar on internal navigation and form submission,
 * a busy state on the pressed submit button, and no second submission of the same form while one is in flight.
 * Purely visual; it never changes what a form sends.
 */
export function NavFeedback() {
  const pathname = usePathname();
  const search = useSearchParams();

  useEffect(() => {
    const root = document.documentElement;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A server response that re-renders the page without changing the URL also ends the busy state.
    // React briefly adds/removes a hidden submitter field inside the form; that is not a response, so it is ignored.
    const observer = new MutationObserver((list) => {
      if (list.some((m) => m.target.nodeName !== "FORM" && !(m.target as Element).closest?.("form[data-pending]")
        && ![...m.addedNodes, ...m.removedNodes].every((n) => n.nodeName === "NEXT-ROUTE-ANNOUNCER"))) clear();
    });
    const clear = () => {
      observer.disconnect();
      root.removeAttribute("data-nav");
      document.querySelectorAll("[data-pending]").forEach((el) => el.removeAttribute("data-pending"));
    };
    const start = () => {
      root.setAttribute("data-nav", "1"); clearTimeout(timer); timer = setTimeout(clear, 8000);
      observer.disconnect(); observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    };

    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const href = a.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname && url.search === location.search) return;
      start();
    };
    const onSubmit = (e: SubmitEvent) => {
      const form = e.target as HTMLFormElement;
      if (form.target === "_blank" || form.hasAttribute("data-own-pending")) return;   // forms that show their own state
      if (form.hasAttribute("data-pending")) { e.preventDefault(); e.stopPropagation(); return; }   // capture phase: React never sees the repeat
      form.setAttribute("data-pending", "1");
      e.submitter?.setAttribute("data-pending", "1");
      start();
    };
    document.addEventListener("click", onClick);
    document.addEventListener("submit", onSubmit, true);
    return () => { document.removeEventListener("click", onClick); document.removeEventListener("submit", onSubmit, true); clearTimeout(timer); observer.disconnect(); };
  }, []);

  // A finished navigation (new path or query) ends the busy state.
  useEffect(() => {
    document.documentElement.removeAttribute("data-nav");
    document.querySelectorAll("[data-pending]").forEach((el) => el.removeAttribute("data-pending"));
  }, [pathname, search]);

  return null;
}
