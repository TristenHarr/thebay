/**
 * Event deep-research (the deterministic core of the AI brief).
 *
 * Given an event, its attendees (with bios), and the viewer's goals/interests,
 * produce a structured brief: a fit score, who to meet and why, VIPs in the room,
 * and talking points. This is fully deterministic so it's testable and always
 * works; a Worker-AI pass can *rephrase* the prose on top, but never changes the
 * picks. Keeping the reasoning here (not in the model) is the pit-of-success move.
 */
export interface ResearchAttendee {
  id: string;
  displayName: string;
  handle: string;
  bio?: string | null;
  isFriend?: boolean;
  mutuals?: number;
}
export interface ResearchInput {
  event: { title: string; venueName?: string | null; startUtc: string; categories?: string[] };
  attendees: ResearchAttendee[];
  goals: string[];
  interests?: string[];
}
export interface WhoToMeet { id: string; displayName: string; handle: string; reason: string; score: number }
export interface Vip { displayName: string; handle: string; note: string }
export interface ResearchBrief {
  headline: string;
  summary: string;
  fitScore: number; // 0–100 — how well this room matches your goals
  whoToMeet: WhoToMeet[];
  vips: Vip[];
  talkingPoints: string[];
}

// Signals that mark someone worth prioritising in a founder room.
const VIP_SIGNALS: { re: RegExp; note: string }[] = [
  { re: /\b(founder|co-?founder|ceo)\b/i, note: "Founder/CEO" },
  { re: /\b(investor|vc|venture|angel|partner|gp|lp)\b/i, note: "Investor" },
  { re: /\b(cto|engineer|infra|systems|kernel|compiler)\b/i, note: "Deep-tech / engineering" },
  { re: /\b(researcher|phd|scientist|professor)\b/i, note: "Researcher" },
  { re: /\b(design|product|pm)\b/i, note: "Product/Design" },
];
const STOP = new Set(["the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "with", "my", "our", "raise", "find", "meet", "get", "build", "want", "need"]);

function keywords(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const w of (t || "").toLowerCase().match(/[a-z][a-z0-9+#-]{2,}/g) || []) if (!STOP.has(w)) out.add(w);
  return out;
}

export function buildResearchBrief(input: ResearchInput): ResearchBrief {
  const wants = keywords([...input.goals, ...(input.interests || [])]);
  const scored: WhoToMeet[] = [];
  const vips: Vip[] = [];

  for (const a of input.attendees) {
    const bio = a.bio || "";
    const bioWords = keywords([bio]);
    const overlap = [...bioWords].filter((w) => wants.has(w));
    let score = overlap.length * 10;
    const reasons: string[] = [];
    if (overlap.length) reasons.push(`shares your focus on ${overlap.slice(0, 3).join(", ")}`);

    const signal = VIP_SIGNALS.find((s) => s.re.test(bio));
    if (signal) { score += 15; vips.push({ displayName: a.displayName, handle: a.handle, note: signal.note }); }
    if (a.isFriend) score -= 100; // you already know them — don't suggest an intro
    else if (a.mutuals && a.mutuals > 0) { score += Math.min(20, a.mutuals * 5); reasons.push(`${a.mutuals} mutual${a.mutuals > 1 ? "s" : ""}`); }

    if (score > 0 && !a.isFriend) {
      scored.push({ id: a.id, displayName: a.displayName, handle: a.handle, score, reason: reasons.join(" · ") || (signal ? signal.note : "worth a hello") });
    }
  }
  scored.sort((x, y) => y.score - x.score);

  const strangers = input.attendees.filter((a) => !a.isFriend).length;
  const fitScore = Math.max(
    0,
    Math.min(100, Math.round((scored.slice(0, 5).reduce((s, w) => s + w.score, 0) / Math.max(1, Math.min(5, scored.length) * 35)) * 60 + (strangers > 0 ? 25 : 0) + (vips.length ? 15 : 0))),
  );

  const talkingPoints: string[] = [];
  if (input.goals.length) talkingPoints.push(`Lead with your goal: “${input.goals[0]}”.`);
  const topOverlap = [...wants].slice(0, 3);
  if (topOverlap.length) talkingPoints.push(`Common ground in the room: ${topOverlap.join(", ")}.`);
  if (vips.length) talkingPoints.push(`${vips.length} founder/investor-type ${vips.length > 1 ? "profiles" : "profile"} attending — have your one-liner ready.`);
  talkingPoints.push(`Aim for ${Math.min(3, Math.max(1, scored.length))} quality conversations, not the whole room.`);

  const summary =
    `${input.event.title} looks like a ${fitScore >= 60 ? "strong" : fitScore >= 35 ? "decent" : "light"} fit for your goals. ` +
    `${strangers} new ${strangers === 1 ? "person" : "people"} to meet` +
    (vips.length ? `, including ${vips.length} founder/investor ${vips.length === 1 ? "profile" : "profiles"}` : "") +
    `. ${scored.length ? `Prioritise ${scored[0]!.displayName}${scored[1] ? ` and ${scored[1]!.displayName}` : ""}.` : "Come with a clear ask."}`;

  return {
    headline: fitScore >= 60 ? "High-signal room for you" : fitScore >= 35 ? "Worth going" : "Optional — go if free",
    summary,
    fitScore,
    whoToMeet: scored.slice(0, 6),
    vips: vips.slice(0, 6),
    talkingPoints,
  };
}
