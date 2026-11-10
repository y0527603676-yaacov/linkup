import { Fragment, type ReactNode } from "react";

/** Isolates the Latin brand name inside Hebrew (or any) text so punctuation and order stay correct in both directions. */
export function withBrand(text: string): ReactNode {
  const parts = text.split("LINKUP");
  if (parts.length === 1) return text;
  return parts.map((p, i) => <Fragment key={i}>{p}{i < parts.length - 1 && <bdi dir="ltr">LINKUP</bdi>}</Fragment>);
}
