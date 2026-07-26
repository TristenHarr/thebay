import { useState } from "react";
import { useGetPlaceKindsQuery, useProposePlaceKindMutation, useVotePlaceKindMutation } from "../../api";
import { Card, Button, Chip, input, Field } from "../../ui/kit";
import { KindFields, type FieldSpec } from "./KindFields";

/**
 * The kind lab — where the crowd decides what this city needs pinned.
 *
 * Anyone can propose a kind (a label, an emoji, how fast its facts rot, and the
 * handful of fields it should ask for); a few votes make it a live map layer.
 * No operator, no deploy: `fields` renders itself everywhere via KindFields.
 */

const TYPES: FieldSpec["type"][] = ["text", "bool", "int", "enum"];
/** Presets for "how fast does this rot", in hours — the concept people struggle
 *  with most, so we ask it in human words rather than as a number. */
const DECAY: Array<[string, number]> = [
  ["changes hourly", 6],
  ["changes daily", 24],
  ["changes monthly", 720],
  ["basically permanent", 2160],
];

export function KindLab({ me }: { me: any }) {
  const { data: proposed } = useGetPlaceKindsQuery("proposed");
  const [propose, { isLoading: proposing }] = useProposePlaceKindMutation();
  const [vote] = useVotePlaceKindMutation();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [emoji, setEmoji] = useState("");
  const [halfLifeHours, setHalfLife] = useState(720);
  const [fields, setFields] = useState<FieldSpec[]>([]);
  const [err, setErr] = useState("");

  const ratify = proposed?.ratifyVotes ?? 3;
  const list = proposed?.kinds ?? [];

  async function submit() {
    setErr("");
    const r: any = await propose({ label: label.trim(), emoji: emoji.trim(), halfLifeHours, fields });
    if (r.error) { setErr(r.error?.data?.error || "Could not propose that"); return; }
    setLabel(""); setEmoji(""); setFields([]); setOpen(false);
  }

  return (
    <Card className="mt-4 p-3" data-testid="kind-lab">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-semibold">What else should this map show?</h3>
        {me && <Button variant="ghost" className="text-xs" onClick={() => setOpen((v) => !v)}>{open ? "Cancel" : "Propose a kind"}</Button>}
      </div>
      <p className="mt-0.5 text-xs text-muted">
        Anyone can propose a layer. {ratify} votes and it goes live for everyone — with the fields you chose.
      </p>

      {open && (
        <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
          <div className="flex gap-2">
            <input className={input} placeholder="Label — e.g. Dog water bowl" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
            <input className="w-20 rounded-lg border border-border bg-surface px-3 py-2 text-center text-lg" placeholder="🐕" value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={4} aria-label="Map icon" />
          </div>
          <Field label="How fast does this go out of date?">
            <div className="flex flex-wrap gap-1.5">
              {DECAY.map(([lbl, h]) => (
                <Chip key={h} on={halfLifeHours === h} onClick={() => setHalfLife(h)}>{lbl}</Chip>
              ))}
            </div>
          </Field>

          <Field label="What should we ask about each one?">
            <div className="flex flex-col gap-2">
              {fields.map((f, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    className={input}
                    placeholder="Question — e.g. Is it working?"
                    value={f.label}
                    onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, label: e.target.value, key: slug(e.target.value) || `f${i}` } : x)))}
                  />
                  <select className="w-28 rounded-lg border border-border bg-surface px-2 text-sm" value={f.type} onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, type: e.target.value as FieldSpec["type"] } : x)))}>
                    {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  {f.type === "enum" && (
                    <input
                      className={input}
                      placeholder="a, b, c"
                      value={(f.options ?? []).join(", ")}
                      onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } : x)))}
                    />
                  )}
                  <button className="px-1 text-muted hover:text-crit" onClick={() => setFields(fields.filter((_, j) => j !== i))} aria-label="Remove field">✕</button>
                </div>
              ))}
              {fields.length < 6 && (
                <Button variant="quiet" className="self-start text-xs" onClick={() => setFields([...fields, { key: `f${fields.length}`, label: "", type: "text" }])}>+ add a question</Button>
              )}
            </div>
          </Field>

          {fields.length > 0 && (
            <div className="rounded-lg border border-border bg-surface/60 p-2">
              <div className="mb-1 font-mono text-[11px] uppercase tracking-wide text-muted">Preview — this is the form people will fill in</div>
              <KindFields fields={fields.filter((f) => f.label)} value={{}} onChange={() => {}} />
            </div>
          )}

          {err && <span className="text-xs text-crit">{err}</span>}
          <Button className="self-start" disabled={proposing || !label.trim() || !emoji.trim()} onClick={submit}>Propose {emoji || "…"} {label || "kind"}</Button>
        </div>
      )}

      {list.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5 border-t border-border pt-3">
          <h4 className="font-mono text-[11px] uppercase tracking-wide text-muted">On the ballot</h4>
          {list.map((k: any) => (
            <div key={k.id} className="flex items-center gap-2 text-sm">
              <span className="text-lg leading-none">{k.emoji}</span>
              <span className="min-w-0 flex-1 truncate">{k.label}</span>
              <span className="font-mono text-xs text-muted">{k.votes}/{ratify}</span>
              <Button variant="ghost" className="px-3 py-1 text-xs" disabled={!me} onClick={() => vote(k.id)}>Back it</Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "f$1").slice(0, 32);
