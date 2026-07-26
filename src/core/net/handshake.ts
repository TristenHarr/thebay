/**
 * The animated handshake — a short cryptographic *film* that two phones have to be
 * pointed at each other to watch.
 *
 * A static QR code proves you obtained a string. It does not prove you were there.
 * Screenshot it, AirDrop it, paste it into Slack — every copy works as well as the
 * original until it expires. That is the wrong shape for the only credential that
 * gates write access to the public catalog.
 *
 * So the code moves. The ambassador's screen plays a sequence of frames at
 * HANDSHAKE_STEP_MS, each frame carrying a code derived from
 *
 *     code(step) = base32( HMAC-SHA256( HANDSHAKE_KEY, sessionId | step ) )
 *
 * and the scanner must capture HANDSHAKE_FRAMES_REQUIRED **consecutive** frames and
 * hand them back while they are still recent. That single requirement changes what
 * the credential means:
 *
 *   · one screenshot is worthless — a single frame is one of four;
 *   · a recorded video is worthless — its steps are in the past, and `verifyFrames`
 *     checks the newest frame against the server's clock, not the client's;
 *   · a relayed still is worthless — the frames must be contiguous, so a forwarded
 *     screenshot can't be padded out with guesses;
 *   · it takes ~1.6 seconds of actually looking at their screen, which is exactly
 *     the human act we're trying to require.
 *
 * Note what the server does NOT store: nothing secret. The codes are recomputed from
 * `HANDSHAKE_KEY` + the session id + the step, so `network_invites` holds no seed, no
 * hash, no token. A database read yields no way to mint a membership.
 *
 * The honest limit, stated plainly rather than papered over: a *complicit*
 * ambassador can forward their live frame list to a confederate elsewhere. Nothing
 * visual can prevent that. Two things bound it — the session is only 30 seconds long,
 * so a leaked list rots almost immediately, and the joiner's GPS must still land
 * within INVITE_RADIUS_M of where the ambassador stood, so the confederate has to
 * spoof location too. Beyond that we stop pretending it's a crypto problem and treat
 * it as what it is: vouching carries liability, and a member who sells entry loses
 * trust when their invitees behave badly (src/core/net/trust.ts).
 */

/** How long one frame is on screen. 400ms ≈ 2.5 codes/second — slow enough that a
 *  phone camera reliably decodes each one, fast enough that four of them is a
 *  moment rather than a wait. */
export const HANDSHAKE_STEP_MS = 400;

/** A whole session. Short on purpose: this is the lifetime of a leaked frame list. */
export const HANDSHAKE_SESSION_MS = 30_000;

/** Consecutive frames the scanner must produce. Four ≈ 1.6s of looking. */
export const HANDSHAKE_FRAMES_REQUIRED = 4;

/** Clock skew we forgive in either direction (±2s at a 400ms step). */
export const HANDSHAKE_SKEW_STEPS = 5;

/** How stale the NEWEST frame may be — the scanner needs time to decode and POST. */
export const HANDSHAKE_MAX_LAG_STEPS = 12; // ~4.8s

/** Characters in a frame code. 10 × 5 bits = 50 bits per frame; four contiguous
 *  frames is 200 bits of "I was looking at that screen". */
const CODE_LEN = 10;

/** Crockford base32 — no I, L, O or U, so nothing is ambiguous on a screen or in a
 *  QR that a camera half-reads. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Which step the wall clock is in. Absolute (epoch-based), so two devices agree
 *  without negotiating anything. */
export function stepAt(atMs: number, stepMs: number = HANDSHAKE_STEP_MS): number {
  const s = Math.max(1, Math.trunc(stepMs) || HANDSHAKE_STEP_MS);
  return Math.floor(atMs / s);
}

/** When a given step began — what the animation uses to stay in phase. */
export function stepStartMs(step: number, stepMs: number = HANDSHAKE_STEP_MS): number {
  return step * Math.max(1, Math.trunc(stepMs) || HANDSHAKE_STEP_MS);
}

async function hmac(key: string, message: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message)));
}

/** The code shown at `step` of `sessionId`. Server-recomputable, client-unguessable. */
export async function frameCode(key: string, sessionId: string, step: number): Promise<string> {
  const bytes = await hmac(key, `${sessionId}|${step}`);
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

export interface Frame {
  step: number;
  code: string;
}

/** The whole film, handed to the ambassador's device to animate. */
export async function frameCodes(key: string, sessionId: string, fromStep: number, count: number): Promise<Frame[]> {
  const n = Math.max(0, Math.min(500, Math.trunc(count) || 0));
  const frames: Frame[] = [];
  for (let i = 0; i < n; i++) {
    const step = fromStep + i;
    frames.push({ step, code: await frameCode(key, sessionId, step) });
  }
  return frames;
}

/** What the QR of a single frame encodes. An `https://` URL so a stock camera app
 *  that catches one frame still lands on the join page, which then opens the real
 *  scanner — one frame is never enough to get in, but it is enough to get started. */
export function framePayload(o: { origin: string; sessionId: string; step: number; code: string }): string {
  const base = o.origin.replace(/\/+$/, "");
  return `${base}/j#s=${encodeURIComponent(o.sessionId)}&t=${o.step}&c=${encodeURIComponent(o.code)}`;
}

export function parseFramePayload(url: string): { sessionId: string; frame: Frame } | null {
  try {
    const p = new URLSearchParams(new URL(url).hash.replace(/^#/, ""));
    const sessionId = p.get("s");
    const step = Number(p.get("t"));
    const code = p.get("c");
    if (!sessionId || !code || !Number.isFinite(step)) return null;
    return { sessionId, frame: { step: Math.trunc(step), code } };
  } catch {
    return null;
  }
}

/** Every way a capture can fail to prove presence. */
export type FrameVerdict = "ok" | "too_few" | "not_contiguous" | "bad_code" | "stale" | "future" | "out_of_session";

export interface VerifyFramesInput {
  key: string;
  sessionId: string;
  /** What the scanner decoded. Order doesn't matter; we sort. */
  frames: Frame[];
  /** The session's own bounds, as steps. */
  startStep: number;
  endStep: number;
  nowMs: number;
  stepMs?: number;
  framesRequired?: number;
}

/**
 * Does this capture prove the scanner watched the live screen?
 *
 * The checks are ordered cheapest-and-most-diagnostic first, and the recency check
 * comes BEFORE the HMAC comparison on purpose: a replayed video has perfectly valid
 * codes, so "is this recent" is the question that actually distinguishes it, and
 * answering it first means a replay attempt costs us no crypto.
 */
export async function verifyFrames(input: VerifyFramesInput): Promise<FrameVerdict> {
  const stepMs = input.stepMs ?? HANDSHAKE_STEP_MS;
  const required = input.framesRequired ?? HANDSHAKE_FRAMES_REQUIRED;

  // Dedup by step — a camera happily decodes the same frame twice, and that is one
  // sighting, not two. Without this, four reads of ONE frame would pass as a run.
  const byStep = new Map<number, string>();
  for (const f of input.frames) {
    if (!f || !Number.isFinite(f.step) || typeof f.code !== "string") continue;
    if (!byStep.has(f.step)) byStep.set(f.step, f.code);
  }
  const steps = [...byStep.keys()].sort((a, b) => a - b);
  if (steps.length < required) return "too_few";

  // Contiguous: no gaps. A forwarded still can't be padded out with guesses, and a
  // capture that skipped frames wasn't watching a screen — it was assembling one.
  for (let i = 1; i < steps.length; i++) if (steps[i]! !== steps[i - 1]! + 1) return "not_contiguous";

  const first = steps[0]!;
  const last = steps[steps.length - 1]!;
  if (first < input.startStep || last > input.endStep) return "out_of_session";

  const nowStep = stepAt(input.nowMs, stepMs);
  if (last > nowStep + HANDSHAKE_SKEW_STEPS) return "future";
  if (last < nowStep - HANDSHAKE_MAX_LAG_STEPS) return "stale";

  for (const step of steps) {
    const expected = await frameCode(input.key, input.sessionId, step);
    const got = byStep.get(step)!;
    // Constant-time-ish: compare the whole string every time. These are not secrets
    // an attacker can grind — each is valid for 400ms — but there's no reason to leak.
    if (expected.length !== got.length) return "bad_code";
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
    if (diff !== 0) return "bad_code";
  }
  return "ok";
}
