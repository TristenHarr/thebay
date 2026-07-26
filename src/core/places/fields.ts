/**
 * The declarative form schema that makes a crowd-proposed place kind work with
 * ZERO new code.
 *
 * A kind stores `fields_json` = [{key,label,type,options?}]. From that one blob
 * the client renders the "add a place" form and the detail sheet, and the server
 * coerces whatever the client posts into exactly those fields. Add a kind called
 * "dog water bowl" with a `bool` field and the whole feature — form, storage,
 * detail sheet, map icon — exists without a deploy. That is the crux of "let
 * people suggest the resource types".
 *
 * Pure, no I/O. Total: malformed field specs are skipped, never thrown on — a
 * bad proposal must not be able to break every reader of that kind.
 */

export const FIELD_TYPES = ["bool", "enum", "int", "text"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
}

export type AttrValue = string | number | boolean;
export type Attrs = Record<string, AttrValue>;

const MAX_FIELDS = 12;
const MAX_TEXT = 120;
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Parse a kind's `fields_json` (string or already-parsed). Bad entries are
 *  dropped, not thrown on; the result is always a (possibly empty) array. */
export function parseFields(raw: unknown): FieldSpec[] {
  let src: unknown = raw;
  if (typeof raw === "string") {
    try { src = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(src)) return [];
  const out: FieldSpec[] = [];
  const seen = new Set<string>();
  for (const f of src) {
    if (!isRecord(f)) continue;
    const key = typeof f.key === "string" ? f.key.trim() : "";
    const type = typeof f.type === "string" ? f.type.trim() : "";
    if (!KEY_RE.test(key) || seen.has(key)) continue;
    if (!(FIELD_TYPES as readonly string[]).includes(type)) continue;
    const label = typeof f.label === "string" && f.label.trim() ? f.label.trim().slice(0, 60) : key;
    const spec: FieldSpec = { key, label, type: type as FieldType };
    if (type === "enum") {
      const options = Array.isArray(f.options)
        ? [...new Set(f.options.filter((o): o is string => typeof o === "string" && !!o.trim()).map((o) => o.trim().slice(0, 40)))].slice(0, 20)
        : [];
      if (!options.length) continue; // an enum with no options is unfillable
      spec.options = options;
    }
    seen.add(key);
    out.push(spec);
    if (out.length >= MAX_FIELDS) break;
  }
  return out;
}

/** Round-trip a validated spec list for storage. */
export const serializeFields = (fields: FieldSpec[]): string => JSON.stringify(fields);

/**
 * Coerce a posted attrs object to the kind's declared shape: unknown keys are
 * dropped, values are converted to the declared type, out-of-vocabulary enum
 * values are dropped. Nothing a client sends can end up stored under a key the
 * kind never declared — which is what keeps `attrs_json` readable forever.
 */
export function coerceAttrs(fields: FieldSpec[], raw: unknown): Attrs {
  if (!isRecord(raw)) return {};
  const out: Attrs = {};
  for (const f of fields) {
    if (!(f.key in raw)) continue;
    const v = raw[f.key];
    if (v === null || v === undefined || v === "") continue;
    switch (f.type) {
      case "bool": {
        if (typeof v === "boolean") out[f.key] = v;
        else if (v === "true" || v === "false") out[f.key] = v === "true";
        else if (v === 1 || v === 0) out[f.key] = v === 1;
        break;
      }
      case "int": {
        // "6 ft" → 6, but "abc" must NOT become 0: Number("") is 0, which would
        // silently store a made-up value the user never typed.
        let n: number;
        if (typeof v === "number") n = v;
        else {
          const digits = String(v).replace(/[^0-9.\-]/g, "");
          n = /^-?\d+(\.\d+)?$/.test(digits) ? Number(digits) : NaN;
        }
        if (Number.isFinite(n)) out[f.key] = Math.trunc(n);
        break;
      }
      case "enum": {
        const s = String(v).trim();
        if (f.options?.some((o) => o.toLowerCase() === s.toLowerCase())) {
          out[f.key] = f.options.find((o) => o.toLowerCase() === s.toLowerCase())!;
        }
        break;
      }
      case "text": {
        const s = String(v).trim().slice(0, MAX_TEXT);
        if (s) out[f.key] = s;
        break;
      }
    }
  }
  return out;
}

/** A URL/DB-safe kind id from a human label ("Dog water bowl" → "dog_water_bowl"). */
export function slugifyKindId(label: string): string {
  return String(label ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

/** Parse a stored attrs blob back into a plain object (never throws). */
export function parseAttrs(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return isRecord(v) ? v : {};
  } catch {
    return {};
  }
}
