import { describe, expect, it } from "vitest";
import { appsFunctionBase, shopifyInstallStart } from "../../src/lib/app-test-shops";

/** Regression: the install link once became "/app/undefined/functions/v1/apps/..." because a deployment had no
 *  NEXT_PUBLIC_SUPABASE_URL. The start URL must always be LINKUP's absolute edge-function address. */
describe("Shopify install start URL", () => {
  const state = "95dfc332bbae47f7bb9d1e377b69085c514ac354";
  it("without the env var: the project's own address, absolute, never 'undefined'", () => {
    const saved = process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    try {
      const u = shopifyInstallStart("linkup-test.myshopify.com", state);
      expect(u).toBe(`https://ycuvcpslvkgndytubycn.supabase.co/functions/v1/apps/shopify/install?shop=linkup-test.myshopify.com&state=${state}`);
      expect(u).not.toMatch(/undefined|null/);
      expect(new URL(u).protocol).toBe("https:");
    } finally { if (saved !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = saved; }
  });
  it("a base with a path or trailing slash still gives the exact function path", () => {
    expect(appsFunctionBase("https://ycuvcpslvkgndytubycn.supabase.co/")).toBe("https://ycuvcpslvkgndytubycn.supabase.co/functions/v1/apps");
  });
  it("refuses bad input instead of building a broken or foreign link", () => {
    expect(() => shopifyInstallStart("evil.com", state)).toThrow();
    expect(() => shopifyInstallStart("linkup-test.myshopify.com", "undefined")).toThrow();
    expect(() => appsFunctionBase("undefined")).toThrow();
  });
});
