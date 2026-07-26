import { Card as Panel, Badge } from "../../ui/kit";

/**
 * THE CARD — what somebody looks like when you catch them.
 *
 * Five stat bars, a rarity frame, type chips and the badges gym leaders have given them. The
 * stats come from `founderStats`, which has existed and been unit-tested since the XP module
 * was written and until now was wired to nothing at all — no query anywhere built its input,
 * so no user had ever seen one.
 *
 * Rarity is derived from `power` — activity and reputation — and never from type. A VC is not
 * rarer than an engineer; somebody who actually turns up is rarer than somebody who doesn't.
 */

const RARITY_STYLE: Record<string, { ring: string; label: string; glow: string }> = {
  common: { ring: "border-border", label: "Common", glow: "" },
  uncommon: { ring: "border-ok/50", label: "Uncommon", glow: "shadow-[0_0_18px_-6px_var(--ok)]" },
  rare: { ring: "border-accent/60", label: "Rare", glow: "shadow-[0_0_22px_-6px_var(--accent)]" },
  epic: { ring: "border-[#a855f7]/70", label: "Epic", glow: "shadow-[0_0_26px_-6px_#a855f7]" },
  legendary: { ring: "border-gold/80", label: "Legendary", glow: "shadow-[0_0_30px_-4px_var(--gold)]" },
};

const AXES: Array<[string, string]> = [
  ["capital", "Capital"],
  ["technical", "Technical"],
  ["network", "Network"],
  ["momentum", "Momentum"],
  ["reach", "Reach"],
];

function StatBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-[11px] text-muted">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
      <span className="w-7 shrink-0 text-right font-mono text-[10px] text-muted">{Math.round(value)}</span>
    </div>
  );
}

export function FounderCardView({ card, compact }: { card: any; compact?: boolean }) {
  if (!card) return null;
  const r = RARITY_STYLE[card.rarity] ?? RARITY_STYLE.common!;
  const pct = Math.round((card.level?.pct ?? 0) * 100);

  return (
    <Panel className={`overflow-hidden border-2 p-0 ${r.ring} ${r.glow}`} data-testid="founder-card">
      {/* name, types, rarity */}
      <div className="flex items-start gap-3 border-b border-border bg-elev p-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{card.displayName}</span>
            {card.types.map((t: any) => (
              <span
                key={t.id}
                className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                style={{ background: `${t.color}22`, color: t.color }}
                title={t.vouches > 0 ? `${t.vouches} vouched` : "Not yet vouched"}
              >
                {t.emoji} {t.label}
                {/* A tick that says somebody stood behind the claim. It buys nothing else. */}
                {t.vouches > 0 && <span className="ml-1 opacity-70">✓{t.vouches}</span>}
              </span>
            ))}
          </div>
          <div className="truncate text-xs text-muted">{card.tagline}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-[10px] uppercase tracking-wide text-muted">{r.label}</div>
          <div className="font-mono text-lg font-bold text-gold">{card.stats.power}</div>
        </div>
      </div>

      {/* level */}
      <div className="flex items-center gap-2 px-3 pt-3">
        <span className="font-mono text-xs font-bold">Lv {card.level?.level ?? 1}</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
          <div className="h-full rounded-full bg-gold" style={{ width: `${pct}%` }} />
        </div>
        <span className="font-mono text-[10px] text-muted">{(card.level?.xp ?? 0).toLocaleString()} XP</span>
      </div>

      {/* the five axes */}
      <div className="flex flex-col gap-1.5 p-3">
        {AXES.map(([key, label]) => (
          <StatBar key={key} label={label} value={card.stats[key] ?? 0} />
        ))}
      </div>

      {!compact && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border p-3">
          {card.trophies > 0 && <Badge>🏆 {card.trophies}</Badge>}
          {/* A host badge ALWAYS shows who gave it and where. That provenance — not the
              namespace — is what stops it passing as a system trophy. */}
          {card.badges.map((b: any) => (
            <span
              key={b.id}
              className="rounded-full border border-border px-2 py-0.5 text-[11px]"
              style={{ color: b.color }}
              title={`Awarded by @${b.awardedBy ?? "a host"}${b.eventTitle ? ` at ${b.eventTitle}` : ""}`}
            >
              {b.emoji} {b.label}
              <span className="ml-1 text-muted">@{b.awardedBy ?? "host"}</span>
            </span>
          ))}
          {card.trophies === 0 && card.badges.length === 0 && (
            <span className="text-xs text-muted">No trophies or badges yet.</span>
          )}
        </div>
      )}
    </Panel>
  );
}
