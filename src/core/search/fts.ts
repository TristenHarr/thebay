/**
 * Building the FTS5 `MATCH` expression.
 *
 * MATCH takes a query LANGUAGE, not a string: `NEAR/3`, `AND`, `OR`, `^`, `-`,
 * `*` and `"` all mean something, and a stray quote is a syntax error that throws
 * rather than returning no rows. So user text is never passed through — it is
 * tokenized down to word characters and every token is re-emitted as a quoted
 * phrase. There is no path by which typed text can become an operator.
 *
 * Pure. `null` means "nothing searchable here" so the caller can skip FTS entirely
 * instead of running a query that can only return zero rows.
 */

/** Word characters only — everything else is punctuation as far as search cares. */
const TOKEN_RE = /[\p{L}\p{N}]+/gu;

/** Bounds the MATCH expression. Ten terms is far more than any real query and
 *  stops a pasted paragraph from becoming a 500-clause disjunction. */
const MAX_TERMS = 10;

/** Prefix-match only tokens long enough for the prefix to mean something: `"ru"*`
 *  matches half the corpus, and `"2026"*` would match every 2026x id. */
const MIN_PREFIX_LEN = 3;

export function toMatchQuery(text: string | null | undefined): string | null {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const m of (text ?? "").toLowerCase().matchAll(TOKEN_RE)) {
    const t = m[0];
    if (!t || seen.has(t)) continue;
    seen.add(t);
    tokens.push(t);
    if (tokens.length >= MAX_TERMS) break;
  }
  if (!tokens.length) return null;
  return tokens
    .map((t) => (t.length >= MIN_PREFIX_LEN && !/^\p{N}+$/u.test(t) ? `"${t}"*` : `"${t}"`))
    .join(" OR ");
}
