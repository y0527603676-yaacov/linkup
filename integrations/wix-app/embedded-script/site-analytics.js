// Variant for an embedded script built with the Wix CLI (instead of the self-managed HTML above):
// the same logic, listening through the official @wix/site analytics API. Bundle together with linkup-ref.html's script.
import { analytics } from "@wix/site";

analytics.registerEventListener((eventName, eventData) => {
  if (typeof window.__linkupWixOnEvent === "function") window.__linkupWixOnEvent(eventName, eventData);
});
