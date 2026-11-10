import { configDefaults, defineConfig } from "vitest/config";
// tests/e2e-wp needs the isolated WordPress test site running (see tests/e2e-wp/README.md): `npm run test:wp`.
export default defineConfig({
  test: {
    testTimeout: 30_000, hookTimeout: 60_000,
    exclude: process.env.LINKUP_WP_E2E ? configDefaults.exclude : [...configDefaults.exclude, "tests/e2e-wp/**"],
  },
});
