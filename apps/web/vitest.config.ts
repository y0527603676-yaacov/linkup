import { configDefaults, defineConfig } from "vitest/config";
// tests/e2e-wp needs the isolated WordPress test site running (see tests/e2e-wp/README.md): `npm run test:wp`.
export default defineConfig({
  test: {
    testTimeout: 30_000, hookTimeout: 60_000,
    // the WordPress suites share local ports (LINKUP endpoint emulator, return page): run them one after another
    fileParallelism: !process.env.LINKUP_WP_E2E,
    exclude: process.env.LINKUP_WP_E2E ? configDefaults.exclude : [...configDefaults.exclude, "tests/e2e-wp/**"],
  },
});
