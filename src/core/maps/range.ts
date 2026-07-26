/**
 * HTTP Range parsing for the offline map packs — PURE (RFC 9110 §14).
 *
 * A PMTiles client fetches a 127-byte header, then a directory, then individual
 * tile slices, all with `Range:` — so this is THE hot path of the vector basemap,
 * and getting 206 semantics subtly wrong shows up as a blank map rather than an
 * error. It lives in core (not the route) so it can be tested exhaustively
 * without an HTTP round trip.
 */
export type RangeSpec =
  /** No (or an unparseable-but-ignorable) Range header — serve the whole body, 200. */
  | { kind: "none" }
  /** Syntactically broken — 400. */
  | { kind: "invalid" }
  /** Syntactically fine but outside the object — 416 + `Content-Range: bytes * /size`. */
  | { kind: "unsatisfiable" }
  | { kind: "range"; offset: number; length: number };

const INT = /^\d+$/;

/**
 * Parse one byte range against a known object size.
 * Multi-range requests return `none` (serving the full body is a legal response
 * to a Range a server chooses not to honour, and multipart/byteranges buys us
 * nothing for PMTiles).
 */
export function parseRangeHeader(header: string | null | undefined, size: number): RangeSpec {
  if (!header) return { kind: "none" };
  const m = /^bytes\s*=\s*(.+)$/i.exec(header.trim());
  if (!m) return { kind: "none" };
  const spec = m[1]!.trim();
  if (spec.includes(",")) return { kind: "none" };

  const dash = spec.indexOf("-");
  if (dash < 0) return { kind: "invalid" };
  const rawStart = spec.slice(0, dash).trim();
  const rawEnd = spec.slice(dash + 1).trim();

  if (rawStart === "") {
    // suffix form: the LAST n bytes
    if (!INT.test(rawEnd)) return { kind: "invalid" };
    const n = Number(rawEnd);
    if (n === 0 || size === 0) return { kind: "unsatisfiable" };
    const length = Math.min(n, size);
    return { kind: "range", offset: size - length, length };
  }

  if (!INT.test(rawStart)) return { kind: "invalid" };
  const start = Number(rawStart);
  if (rawEnd !== "" && !INT.test(rawEnd)) return { kind: "invalid" };
  const end = rawEnd === "" ? size - 1 : Number(rawEnd);
  if (rawEnd !== "" && end < start) return { kind: "invalid" };
  if (size === 0 || start >= size) return { kind: "unsatisfiable" };
  const last = Math.min(end, size - 1);
  return { kind: "range", offset: start, length: last - start + 1 };
}

/** `bytes 0-99/1000` for a 206 response. */
export function contentRange(offset: number, length: number, size: number): string {
  return `bytes ${offset}-${offset + length - 1}/${size}`;
}
