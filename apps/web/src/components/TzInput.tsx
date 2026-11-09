"use client";
import { useEffect, useState } from "react";
/** Sends the browser's UTC offset so campaign dates mean local days. */
export function TzInput() {
  const [tz, setTz] = useState("0");
  useEffect(() => setTz(String(new Date().getTimezoneOffset())), []);
  return <input type="hidden" name="tz" value={tz} />;
}
