import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { hmacHex, normalizeConnectionId, verifySignature } from "../../../supabase/functions/woo/hmac";

const PLUGIN = new URL("../../../plugins/woocommerce/linkup-connector/linkup-connector.php", import.meta.url).pathname;

/** Signs with the plugin's own linkup_sign() so PHP and the Edge Function are checked against each other. */
function phpSign(body: string, ts: number, secret: string): string {
  const code = `define('ABSPATH','/');function add_action(){}function register_deactivation_hook(){}function plugin_dir_path(){}
include ${JSON.stringify(PLUGIN)}; echo linkup_sign($argv[1], (int)$argv[2], $argv[3]);`;
  return execFileSync("php", ["-r", code, "--", body, String(ts), secret], { encoding: "utf8" });
}

describe("plugin ↔ edge function signature compatibility", () => {
  const secret = "a".repeat(64);
  const body = JSON.stringify({ action: "event", event: { order: { id: "1", total: 12345, note: "שלום" } } });
  const now = Math.floor(Date.now() / 1000);

  it("PHP plugin signature verifies in the Edge Function code (incl. Hebrew text)", async () => {
    const sig = phpSign(body, now, secret);
    expect(sig).toBe(await hmacHex(secret, `${now}.${body}`));
    expect(await verifySignature(body, sig, now, secret, now + 5)).toBe(true);
  });

  it("rejects tampering, wrong secret, stale timestamp and malformed signature", async () => {
    const sig = phpSign(body, now, secret);
    expect(await verifySignature(body.replace("12345", "99999"), sig, now, secret, now)).toBe(false);
    expect(await verifySignature(body, sig, now, "b".repeat(64), now)).toBe(false);
    expect(await verifySignature(body, sig, now, secret, now + 301)).toBe(false);
    expect(await verifySignature(body, "zz", now, secret, now)).toBe(false);
  });

  it("normalizes connection ids", () => {
    expect(normalizeConnectionId("0123456789abcdef0123456789ABCDEF")).toBe("01234567-89ab-cdef-0123-456789abcdef");
    expect(normalizeConnectionId("not-a-uuid")).toBeNull();
  });
});
