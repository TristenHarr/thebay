/**
 * Moved to `src/core/ratelimit.ts` when the scrape network needed the same policy — both
 * Workers rate-limit now, and one copy is the point. Re-exported from here so every existing
 * news import site keeps working unchanged.
 */
export { LIMITS, rateVerdict, waitMessage } from "../core/ratelimit";
export type { Limit, Verdict } from "../core/ratelimit";
