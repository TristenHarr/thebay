import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  useGetEventBadgesQuery,
  useMintGymBadgeMutation,
  useAwardGymBadgeMutation,
  useGetGymQuery,
  useSetGymPolicyMutation,
  useArmGymMutation,
  useSettleGymMutation,
  useAwardGymMutation,
  useBulkAwardGymMutation,
  useRevokeGymAwardMutation,
} from "../../api";
import { Button, Card, Spinner, PageHeader, EmptyState, Badge, Field, input, cx } from "../../ui/kit";

/**
 * The gym leader's dashboard.
 *
 * Two ideas drive the layout:
 *
 *  · **the budget meter is the headline.** A host's first question is "how much can I give
 *    out?", and the answer is not a number they chose — it is what verified attendance
 *    bought. Showing the reason underneath ("4 verified attendees × standing 1.00") is what
 *    stops a host with an empty budget concluding the feature is broken.
 *
 *  · **the roster is capped per person, visibly.** Each row shows how long that person
 *    stayed and the most they may still be given, because those two numbers are the rules
 *    of the game and hiding them makes the caps feel arbitrary rather than fair.
 */

const MODES = [
  { key: "none", label: "Nothing", hint: "Publish that this event awards no XP." },
  { key: "flat", label: "Flat", hint: "The same to everyone who showed up." },
  { key: "discretion", label: "My call", hint: "Decide per person at the door." },
  { key: "bounty", label: "Bounties", hint: "Named feats at set prices." },
] as const;

const AWARD_COPY: Record<string, string> = {
  over_cap: "That's above what they've earned — check their time at the event.",
  over_budget: "Not enough budget left.",
  no_budget: "This gym has no budget left.",
  not_present: "They never scanned in at the door.",
  duplicate: "You've already awarded them.",
  self: "You can't award yourself.",
  not_armed: "Publish the terms first.",
  already_settled: "This gym is closed.",
  outside_window: "Awards are closed for this event.",
};

function Meter({ spent, budget }: { spent: number; budget: number }) {
  const pct = budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-border">
      <div className={cx("h-full rounded-full", pct > 90 ? "bg-warn" : "bg-accent")} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Gym() {
  const { id = "" } = useParams();
  const { data, isLoading } = useGetGymQuery(id, { skip: !id });
  const [setPolicy] = useSetGymPolicyMutation();
  const [arm] = useArmGymMutation();
  const [settle] = useSettleGymMutation();
  const [award] = useAwardGymMutation();
  const [bulkAward] = useBulkAwardGymMutation();
  const [revoke] = useRevokeGymAwardMutation();

  const [mode, setMode] = useState<string>("flat");
  const [flatXp, setFlatXp] = useState(50);
  const [msg, setMsg] = useState<string | null>(null);
  const [amounts, setAmounts] = useState<Record<string, number>>({});

  if (isLoading) return <Spinner />;

  const gym = data?.gym;
  const isHost = !!data?.isHost;
  const roster: any[] = data?.roster || [];
  const awards: any[] = data?.awards || [];
  const reasons: string[] = data?.budget?.reasons || [];

  if (!isHost) {
    return (
      <div data-testid="gym">
        <PageHeader title="Gym" sub="Only the host of this event can run its gym." />
        <EmptyState title="Not your gym" hint="Ask the host to open the door if you're attending." />
      </div>
    );
  }

  async function publish() {
    const r: any = await setPolicy({ eventId: id, mode, flatXp, bounties: [] });
    setMsg(r.error ? (r.error.data?.error ?? "Couldn't save the terms.") : "Terms saved.");
  }

  async function give(userId: string, xp: number) {
    const r: any = await award({ eventId: id, userId, xp });
    const result = r.data?.result ?? r.error?.data?.result;
    setMsg(result === "ok" ? "Awarded." : (AWARD_COPY[result] ?? "Couldn't award that."));
  }

  /** "Flat to everyone", one call. Each person is capped by their own dwell, so a partial
   *  result is normal rather than a failure — the response says who got what. */
  async function giveAll() {
    const eligible = roster.filter((r) => r.remainingCap > 0);
    if (!eligible.length) return setMsg("Nobody has an unused allowance right now.");
    const r: any = await bulkAward({
      eventId: id,
      awards: eligible.map((p) => ({ userId: p.userId, xp: Math.min(gym.flatXp || p.remainingCap, p.remainingCap) })),
    });
    setMsg(r.data ? `Awarded ${r.data.granted} of ${eligible.length}.` : "Couldn't run the batch.");
  }

  return (
    <div data-testid="gym">
      <PageHeader
        title="Gym"
        sub="Reward the people who actually turned up. What you can give is set by verified attendance and how long they stayed."
        right={
          <Link className="font-mono text-sm text-accent hover:underline" to={`/event/${id}/door`}>
            Open the door →
          </Link>
        }
      />

      {msg && (
        <Card className="mb-4 p-3 text-sm" data-testid="gym-message">
          {msg}
        </Card>
      )}

      {/* ── the budget ─────────────────────────────────────────────────────── */}
      <Card className="mb-4 p-4" data-testid="gym-budget">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-muted">Budget</span>
          <span className="font-mono text-xl font-bold text-gold">
            {(gym?.spent ?? 0).toLocaleString()}
            <span className="text-muted"> / {(gym?.budget ?? 0).toLocaleString()} XP</span>
          </span>
        </div>
        <div className="mt-2">
          <Meter spent={gym?.spent ?? 0} budget={gym?.budget ?? 0} />
        </div>
        {/* Never leave a host guessing why the number is what it is. */}
        {reasons.map((r) => (
          <p key={r} className="mt-2 text-xs text-muted">
            {r}
          </p>
        ))}
        <div className="mt-3 flex items-center gap-3 text-xs text-muted">
          <span>{gym?.attendees ?? 0} verified in the room</span>
          <span>·</span>
          <span className={gym?.status === "armed" ? "text-ok" : ""}>
            {gym?.status === "armed" ? "Terms are live" : gym?.status === "settled" ? "Closed" : "Draft — not published"}
          </span>
        </div>
      </Card>

      {/* ── the terms ──────────────────────────────────────────────────────── */}
      {gym?.status === "draft" || !gym ? (
        <Card className="mb-4 p-4" data-testid="gym-terms">
          <h3 className="mb-3 text-sm font-semibold">Your rules</h3>
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {MODES.map((m) => (
              <button
                key={m.key}
                onClick={() => setMode(m.key)}
                className={cx(
                  "rounded-lg border p-2 text-left text-xs",
                  mode === m.key ? "border-accent bg-elev" : "border-border",
                )}
              >
                <div className="font-semibold">{m.label}</div>
                <div className="text-muted">{m.hint}</div>
              </button>
            ))}
          </div>
          {mode === "flat" && (
            <Field label="XP each">
              <input
                className={input}
                type="number"
                min={1}
                max={1000}
                value={flatXp}
                onChange={(e) => setFlatXp(Number(e.target.value))}
              />
            </Field>
          )}
          <div className="mt-3 flex gap-2">
            <Button onClick={publish}>Save terms</Button>
            <Button variant="ghost" onClick={async () => setMsg((await arm(id)).error ? "Couldn't publish." : "Terms published.")}>
              Publish &amp; open
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted">
            Publishing locks the terms so attendees can trust them. You can still award and correct until the gym closes.
          </p>
        </Card>
      ) : (
        <Card className="mb-4 flex items-center justify-between p-4">
          <div className="text-sm">
            <span className="font-semibold">
              {gym.mode === "flat" ? `${gym.flatXp} XP to everyone who showed` : gym.mode === "none" ? "No XP at this event" : gym.mode === "bounty" ? "Bounties" : "Host's discretion"}
            </span>
            <span className="ml-2 text-xs text-muted">locked when you published</span>
          </div>
          {gym.status === "armed" && (
            <Button variant="ghost" onClick={async () => setMsg((await settle(id)).error ? "Couldn't close." : "Gym closed.")}>
              Close gym
            </Button>
          )}
        </Card>
      )}

      {/* ── the ceremony ───────────────────────────────────────────────────── */}
      {gym?.status !== "draft" && <BadgePanel eventId={id} roster={roster} onMessage={setMsg} />}

      {/* ── the roster ─────────────────────────────────────────────────────── */}
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">Who showed up</h3>
        {gym?.status === "armed" && gym.mode === "flat" && (
          <Button variant="quiet" onClick={giveAll}>
            Award everyone
          </Button>
        )}
      </div>
      {roster.length === 0 ? (
        <EmptyState title="Nobody has scanned in" hint="Open the door and show the QR at the entrance." />
      ) : (
        <div className="flex flex-col gap-2" data-testid="gym-roster">
          {roster.map((p) => (
            <Card key={p.userId} className="flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{p.displayName}</div>
                <div className="font-mono text-[11px] text-muted">
                  {p.dwellMinutes}m in the room
                  {p.dwellMultiplier < 1 && <span className="text-warn"> · {Math.round(p.dwellMultiplier * 100)}% allowance</span>}
                  {p.awarded > 0 && <span className="text-gold"> · +{p.awarded} given</span>}
                </div>
              </div>
              {gym?.status === "armed" ? (
                p.remainingCap > 0 ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <input
                      className="w-20 rounded-lg border border-border bg-surface px-2 py-1 text-right font-mono text-sm"
                      type="number"
                      min={1}
                      max={p.remainingCap}
                      value={amounts[p.userId] ?? Math.min(gym.flatXp || p.remainingCap, p.remainingCap)}
                      onChange={(e) => setAmounts({ ...amounts, [p.userId]: Number(e.target.value) })}
                    />
                    <Button onClick={() => give(p.userId, amounts[p.userId] ?? Math.min(gym.flatXp || p.remainingCap, p.remainingCap))}>
                      Give
                    </Button>
                    <span className="w-14 shrink-0 text-right font-mono text-[11px] text-muted">max {p.remainingCap}</span>
                  </div>
                ) : (
                  <Badge>Maxed out</Badge>
                )
              ) : null}
            </Card>
          ))}
        </div>
      )}

      {/* ── what's been given ──────────────────────────────────────────────── */}
      {awards.length > 0 && (
        <>
          <h3 className="mb-2 mt-6 text-sm font-semibold">Awarded</h3>
          <div className="flex flex-col gap-2">
            {awards.map((a) => (
              <Card key={a.id} className="flex items-center gap-3 p-3 text-sm">
                <span className="font-mono text-gold">+{a.xp}</span>
                <span className="min-w-0 flex-1 truncate">{a.displayName}</span>
                {a.bountyKey && <Badge>{a.bountyKey.replace(/_/g, " ")}</Badge>}
                {gym?.status === "armed" && (
                  <Button
                    variant="quiet"
                    onClick={async () => {
                      const reason = window.prompt("Why are you taking this back? The recipient is told.");
                      if (!reason) return;
                      const r: any = await revoke({ eventId: id, awardId: a.id, reason });
                      setMsg(r.error ? "Couldn't revoke." : "Revoked.");
                    }}
                  >
                    Undo
                  </Button>
                )}
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}


/**
 * Badges — the gym leader's ceremony.
 *
 * Deliberately separate from the XP controls above, because a badge is NOT a payment. There is
 * no `xp` column on `gym_badges`: if a badge paid, the budget in migrations/0028 would be
 * bypassable through badges and the whole anti-inflation bound would be decorative. A bounty is
 * money; a badge is a story you tell about somebody.
 */
function BadgePanel({ eventId, roster, onMessage }: { eventId: string; roster: any[]; onMessage: (m: string) => void }) {
  const { data } = useGetEventBadgesQuery(eventId);
  const [mint] = useMintGymBadgeMutation();
  const [award] = useAwardGymBadgeMutation();
  const [label, setLabel] = useState("");
  const [emoji, setEmoji] = useState("🏅");
  const badges = data?.badges ?? [];

  async function create() {
    if (!label.trim()) return onMessage("Give the badge a name.");
    const r: any = await mint({ eventId, label: label.trim(), emoji });
    // The server refuses a name that collides with a system trophy, and says why.
    onMessage(r.error ? (r.error.data?.error ?? "Couldn't mint that badge.") : `Minted ${emoji} ${label}.`);
    if (!r.error) setLabel("");
  }

  return (
    <Card className="mb-4 p-4" data-testid="gym-badges">
      <h3 className="mb-2 text-sm font-semibold">Badges</h3>
      <p className="mb-3 text-xs text-muted">
        Your own ceremony — "Best Demo", "Stayed Till The End". Badges carry your name and cost no XP.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input className="w-14 rounded-lg border border-border bg-surface px-2 py-1 text-center text-lg" value={emoji} onChange={(e) => setEmoji(e.target.value)} aria-label="Badge emoji" />
        <input className={cx(input, "flex-1 min-w-[10rem]")} placeholder="Best Demo" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} />
        <Button onClick={create}>Mint</Button>
      </div>

      {badges.length === 0 ? (
        <p className="text-xs text-muted">No badges yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {badges.map((b: any) => (
            <div key={b.id} className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-border px-2 py-0.5 text-xs" style={{ color: b.color }}>
                {b.emoji} {b.label}
              </span>
              <span className="text-xs text-muted">give to:</span>
              {roster.map((p) => (
                <button
                  key={p.userId}
                  className="rounded-full border border-border px-2 py-0.5 text-[11px] hover:border-accent"
                  onClick={async () => {
                    const r: any = await award({ eventId, badgeId: b.id, userId: p.userId });
                    onMessage(r.error ? "Couldn't award that." : r.data?.already ? `${p.displayName} already has it.` : `Gave ${b.label} to ${p.displayName}.`);
                  }}
                >
                  {p.displayName}
                </button>
              ))}
              {roster.length === 0 && <span className="text-[11px] text-muted">nobody has scanned in yet</span>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
