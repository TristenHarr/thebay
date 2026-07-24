import { distance } from "fastest-levenshtein";
import { normalizeTitle, tokenSet } from "../normalize/text";

/**
 * Title similarity in [0,1] — max of normalized Levenshtein ratio and token-set
 * Jaccard, so it catches both typo-level and word-reorder variants.
 */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const lev = 1 - distance(na, nb) / Math.max(na.length, nb.length);

  const ta = tokenSet(a);
  const tb = tokenSet(b);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = new Set([...ta, ...tb]).size;
  const jac = union ? inter / union : 0;

  return Math.max(lev, jac);
}
