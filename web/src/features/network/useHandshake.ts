/**
 * The handshake's client logic, kept out of the component so it can be reasoned about (and
 * tested) without a camera or a DOM.
 *
 * Two halves:
 *
 *   · `frameAt` — which frame of the film should be on screen right now. Driven by the wall
 *     clock against the server's absolute step boundaries, so the display stays in phase with
 *     the verifier without either side negotiating anything. A naive `setInterval` cursor
 *     would drift, and a drifting display shows codes the server has already moved past.
 *
 *   · `FrameCollector` — accumulates what the camera decodes into a CONTIGUOUS run. This is
 *     the part that carries the security property: a screenshot yields one frame, a recorded
 *     video yields frames the server will reject as stale, and a camera that reads the same
 *     frame forty times still yields one sighting. The collector's job is to notice when it
 *     genuinely has an unbroken run and stop, rather than filming indefinitely.
 */

export interface Frame {
  step: number;
  code: string;
  /** Wall-clock ms at which this frame is due. */
  at: number;
  /** The https URL this frame's QR encodes. */
  payload: string;
}

export interface Session {
  sessionId: string;
  expiresAt: string;
  stepMs: number;
  framesRequired: number;
  startStep: number;
  endStep: number;
  frames: Frame[];
}

/**
 * The frame due at `nowMs`, or null once the session has run out. Binary-searched rather than
 * scanned so a 30-second session (75 frames) costs nothing at 60fps.
 */
export function frameAt(session: Session, nowMs: number): Frame | null {
  const frames = session.frames;
  if (!frames?.length) return null;
  const step = Math.floor(nowMs / Math.max(1, session.stepMs));
  if (step < session.startStep || step > session.endStep) return null;
  const i = step - session.startStep;
  return frames[i] ?? null;
}

/** 0..1 through the session — the countdown ring. Clamped, so a stale session reads as full. */
export function sessionProgress(session: Session, nowMs: number): number {
  const start = session.startStep * session.stepMs;
  const end = (session.endStep + 1) * session.stepMs;
  if (end <= start) return 1;
  return Math.min(1, Math.max(0, (nowMs - start) / (end - start)));
}

/** Should the display fetch its next session? Early enough that the roll is seamless. */
export function shouldRenew(session: Session, nowMs: number, leadMs = 3000): boolean {
  return nowMs >= (session.endStep + 1) * session.stepMs - leadMs;
}

export type CollectorState = "watching" | "ready";

/**
 * Gathers decoded frames into a contiguous run for one session.
 *
 * Contiguity is enforced here as well as on the server, for a plain UX reason: if the camera
 * misses a frame we want to start the run over and keep filming, rather than send the server
 * something it will refuse and make the user wonder why "it didn't work".
 */
export class FrameCollector {
  private sessionId: string | null = null;
  private run: Frame[] = [];

  constructor(private framesRequired: number) {}

  get state(): CollectorState {
    return this.run.length >= this.framesRequired ? "ready" : "watching";
  }

  /** How much of the run is captured, 0..1 — the progress arc while scanning. */
  get progress(): number {
    return Math.min(1, this.run.length / Math.max(1, this.framesRequired));
  }

  get captured(): Array<{ step: number; code: string }> {
    return this.run.map((f) => ({ step: f.step, code: f.code }));
  }

  get session(): string | null {
    return this.sessionId;
  }

  reset(): void {
    this.sessionId = null;
    this.run = [];
  }

  /**
   * Feed one decoded payload. Returns the state after doing so.
   *
   * A frame from a different session restarts the run — that happens legitimately every time
   * the ambassador's display rolls into its next session, and treating it as an error would
   * make a perfectly good scan fail every 30 seconds.
   */
  push(decoded: { sessionId: string; step: number; code: string }): CollectorState {
    if (!decoded || !Number.isFinite(decoded.step) || !decoded.code) return this.state;

    if (decoded.sessionId !== this.sessionId) {
      this.sessionId = decoded.sessionId;
      this.run = [{ step: decoded.step, code: decoded.code, at: 0, payload: "" }];
      return this.state;
    }

    const last = this.run[this.run.length - 1];
    if (!last) {
      this.run = [{ step: decoded.step, code: decoded.code, at: 0, payload: "" }];
      return this.state;
    }
    if (decoded.step === last.step) return this.state; // the same frame read twice
    if (decoded.step === last.step + 1) {
      this.run.push({ step: decoded.step, code: decoded.code, at: 0, payload: "" });
      // Keep only what we need, so a long scan doesn't grow unbounded.
      if (this.run.length > this.framesRequired * 3) this.run = this.run.slice(-this.framesRequired * 2);
      return this.state;
    }
    // A gap: the run is broken. Start again from here rather than sending a hole.
    this.run = [{ step: decoded.step, code: decoded.code, at: 0, payload: "" }];
    return this.state;
  }
}

/** Parse a frame URL the camera decoded. Mirrors `parseFramePayload` on the server. */
export function parseFrameUrl(text: string): { sessionId: string; step: number; code: string } | null {
  try {
    const p = new URLSearchParams(new URL(text).hash.replace(/^#/, ""));
    const sessionId = p.get("s");
    const step = Number(p.get("t"));
    const code = p.get("c");
    if (!sessionId || !code || !Number.isFinite(step)) return null;
    return { sessionId, step: Math.trunc(step), code };
  } catch {
    return null;
  }
}
