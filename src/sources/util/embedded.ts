/* eslint-disable @typescript-eslint/no-explicit-any */

/** Balanced-brace scan starting at the `{` following `marker`. */
function scan(html: string, from: number): { value: any; raw: string } | null {
  const start = html.indexOf("{", from);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let quote = "";
  for (let k = start; k < html.length; k++) {
    const c = html[k]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === quote) inStr = false;
    } else if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        const raw = html.slice(start, k + 1);
        try {
          return { value: JSON.parse(raw), raw };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Extract the object assigned/keyed right after `marker` (e.g. `"accessPolicy":`). */
export function extractObjectAfter(
  html: string,
  marker: string,
): { value: any; raw: string } | null {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  return scan(html, i + marker.length);
}
