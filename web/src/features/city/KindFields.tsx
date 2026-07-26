import { input } from "../../ui/kit";

/**
 * The declarative form renderer. A place kind stores `fields_json`
 * ([{key,label,type,options?}]) and THIS is the only code that reads it — which
 * is why a kind the crowd invents this afternoon gets a working "add a place"
 * form, a working edit form and a readable detail sheet with no deploy.
 *
 * Deliberately dumb: no per-kind branches anywhere in the app. If you find
 * yourself writing `if (kind.id === 'parking')` in a form, add a field type here
 * instead.
 */

export interface FieldSpec {
  key: string;
  label: string;
  type: "bool" | "enum" | "int" | "text";
  options?: string[];
}
export type AttrValues = Record<string, unknown>;

export function KindFields({ fields, value, onChange }: { fields: FieldSpec[]; value: AttrValues; onChange: (v: AttrValues) => void }) {
  if (!fields?.length) return null;
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  return (
    <div className="grid grid-cols-2 gap-2">
      {fields.map((f) => (
        <label key={f.key} className={f.type === "bool" ? "col-span-1 flex items-center gap-2 text-sm" : "col-span-2 flex flex-col gap-1 text-xs text-muted sm:col-span-1"}>
          {f.type === "bool" ? (
            <>
              <input type="checkbox" checked={!!value[f.key]} onChange={(e) => set(f.key, e.target.checked)} />
              <span className="text-text">{f.label}</span>
            </>
          ) : (
            <>
              <span>{f.label}</span>
              {f.type === "enum" ? (
                <select className={input} value={String(value[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)}>
                  <option value="">—</option>
                  {(f.options ?? []).map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <input
                  className={input}
                  type={f.type === "int" ? "number" : "text"}
                  value={String(value[f.key] ?? "")}
                  onChange={(e) => set(f.key, e.target.value)}
                  placeholder={f.type === "int" ? "0" : ""}
                />
              )}
            </>
          )}
        </label>
      ))}
    </div>
  );
}

/** Drop blanks so we never post an empty string the server would only discard. */
export function cleanAttrs(v: AttrValues): AttrValues {
  const out: AttrValues = {};
  for (const [k, val] of Object.entries(v)) {
    if (val === "" || val === null || val === undefined || val === false) continue;
    out[k] = val;
  }
  return out;
}

/** Human-readable attrs for the detail sheet, driven by the same spec. */
export function describeAttrs(fields: FieldSpec[], attrs: AttrValues): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const f of fields ?? []) {
    const v = attrs?.[f.key];
    if (v === undefined || v === null || v === "") continue;
    out.push([f.label, f.type === "bool" ? (v ? "yes" : "no") : String(v)]);
  }
  return out;
}
