"use client";
import { trackShare } from "@/app/app/actions";
import { CopyButton } from "./CopyButton";

/** WhatsApp + copy, with a share event recorded for the growth funnel. */
export function ShareButtons({ org, text, copyText, labels, event = "creative_shared" }: {
  org: string; text: string; copyText?: string; labels: { wa: string; copy: string; copied: string };
  event?: "creative_shared" | "referral_link_shared";
}) {
  const track = () => { void trackShare(org, event).catch(() => undefined); };
  return (
    <div className="row">
      <a className="btn btn-wa grow" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener" onClick={track}>{labels.wa}</a>
      <CopyButton text={copyText ?? text} label={labels.copy} done={labels.copied} onCopied={track} className="btn btn-ghost" />
    </div>
  );
}
