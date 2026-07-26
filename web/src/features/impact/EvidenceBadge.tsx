import { type Evidence } from "../../../../src/core/attribution/ledger";

/**
 * The evidence ladder, rendered.
 *
 * The four tiers get four visibly different treatments, and `platform` gets the
 * dashed, muted one on purpose: it is a CO-OCCURRENCE ("met here 5 months
 * before"), not a claim that anything caused anything. If these ever start
 * looking alike, the product has begun publishing claims it cannot support.
 */
const STYLE: Record<Evidence, string> = {
  sec: "border-gold text-gold",
  counterparty: "border-accent text-accent",
  self: "border-border text-text",
  platform: "border-dashed border-border text-muted",
};

export function EvidenceBadge({ evidence, label }: { evidence: Evidence | string; label: string }) {
  const tier = (evidence in STYLE ? evidence : "platform") as Evidence;
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STYLE[tier]}`}
      title={tier === "platform" ? "Co-occurrence only — the connection predates the outcome. Not a claim about cause." : `Evidence: ${tier}`}
      data-evidence={tier}
    >
      {label}
    </span>
  );
}

/** Spelled out once per screen, so nobody has to guess what a badge means. */
export function EvidenceLegend() {
  const rows: [Evidence, string, string][] = [
    ["sec", "$4.2M · Form D", "the round is on the public record"],
    ["counterparty", "confirmed by both", "both sides confirmed the causal link"],
    ["self", "claimed by @ann", "one party claims it"],
    ["platform", "met here 5 months before", "co-occurrence only — never causation"],
  ];
  return (
    <details className="mb-4 rounded-lg border border-border bg-elev p-3 text-sm" data-testid="evidence-legend">
      <summary className="cursor-pointer font-semibold">How to read the evidence</summary>
      <ul className="mt-2 flex flex-col gap-2">
        {rows.map(([tier, label, meaning]) => (
          <li key={tier} className="flex items-center gap-2">
            <EvidenceBadge evidence={tier} label={label} />
            <span className="text-muted">{meaning}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
