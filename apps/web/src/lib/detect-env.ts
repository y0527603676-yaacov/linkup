import "server-only";
import { localTestFetch, type Fetcher } from "./store-detect";

/** Detection options for the app. Production always uses the public, HTTPS-only, SSRF-safe fetcher.
 *  Only an isolated local test run (both LINKUP_LOCAL_HTTP and LINKUP_DETECT_LOCAL set, never on Vercel) may check
 *  plain-http loopback sites, so the exact owner flow can be tested end to end against real local sites. */
export function detectOpts(site: string): { fetcher?: Fetcher; allowHttp?: boolean } {
  if (process.env.LINKUP_LOCAL_HTTP && process.env.LINKUP_DETECT_LOCAL && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(site.trim()))
    return { fetcher: localTestFetch, allowHttp: true };
  return {};
}
