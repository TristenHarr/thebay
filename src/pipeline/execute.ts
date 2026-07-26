/**
 * Run ONE recipe and return what it found. Extracted from `runScrape` so the same code
 * path serves both callers:
 *
 *   · the local pipeline (src/pipeline/pipeline.ts), which then normalises and stores
 *     into local SQLite, exactly as it always has;
 *   · a network worker (src/net/client.ts), which stops here and ships the RawEvents to
 *     the coordinator, because normalisation is the SERVER's job in that direction.
 *
 * That split is the whole reason this file exists. A volunteer client must not normalise:
 * the moment it does, it is computing the fingerprint that decides which existing event
 * its data merges into, and no amount of validation downstream can un-ring that bell.
 * Stopping at `RawEvent[]` means a worker reports observations and the server decides what
 * they mean.
 *
 * The failure contract is the adapters' existing one, unchanged: `fetchEvents` throws only
 * when a whole source is unreachable, and per-item problems are skipped. So a throw from
 * here means "this source failed", which is exactly what a lease needs to know.
 */
import { getAdapter } from "../sources/registry";
import type { AdapterContext } from "../sources/types";
import { RawEventSchema, type RawEvent } from "../core/models/event";

export interface RecipeRef {
  /** Source id, for logs and for the run record. */
  id: string;
  type: string;
  params: unknown;
}

export interface ExecuteOutcome {
  raws: RawEvent[];
  /** Items the adapter produced that don't satisfy RawEventSchema — dropped, and counted
   *  rather than silently swallowed, because a rising number here means a site changed. */
  malformed: number;
  durationMs: number;
}

/**
 * Fetch one source through its registered adapter, validating each item against
 * `RawEventSchema` on the way out. Returns only well-formed raws, so every caller can
 * trust the shape without re-checking.
 */
export async function executeRecipe(recipe: RecipeRef, ctx: AdapterContext): Promise<ExecuteOutcome> {
  const started = Date.now();
  const adapter = getAdapter(recipe.type);
  const params = adapter.parseParams(recipe.params);
  const produced = await adapter.fetchEvents({ id: recipe.id, type: recipe.type, enabled: true, params }, ctx);

  const raws: RawEvent[] = [];
  let malformed = 0;
  for (const r of produced) {
    const parsed = RawEventSchema.safeParse(r);
    if (parsed.success) raws.push(parsed.data);
    else malformed++;
  }
  return { raws, malformed, durationMs: Date.now() - started };
}
