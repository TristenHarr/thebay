/**
 * The handshake's client-side logic — the display's clock and the scanner's collector.
 *
 * Both carry security properties, so both are tested here rather than being left to a
 * Playwright pass that would need a camera pointed at a screen:
 *
 *   · the display must stay in phase with the SERVER's absolute step boundaries, because a
 *     locally-timed cursor drifts and a drifted display shows codes the verifier has retired;
 *   · the collector must only ever produce a CONTIGUOUS run, because contiguity is what makes
 *     a screenshot (one frame) and a stuck camera (one frame, forty times) worthless.
 */
import { describe, it, expect } from "vitest";
import {
  frameAt,
  sessionProgress,
  shouldRenew,
  FrameCollector,
  parseFrameUrl,
  type Session,
} from "../web/src/features/network/useHandshake";
import { framePayload, frameCodes, HANDSHAKE_STEP_MS } from "../src/core/net/handshake";

const STEP = HANDSHAKE_STEP_MS;

/** A session shaped exactly as `POST /api/net/invite` returns one. */
async function makeSession(startStep: number, count: number): Promise<Session> {
  const frames = await frameCodes("k", "sess", startStep, count);
  return {
    sessionId: "sess",
    expiresAt: new Date((startStep + count) * STEP).toISOString(),
    stepMs: STEP,
    framesRequired: 4,
    startStep,
    endStep: startStep + count - 1,
    frames: frames.map((f) => ({
      ...f,
      at: f.step * STEP,
      payload: framePayload({ origin: "https://thebay.events", sessionId: "sess", ...f }),
    })),
  };
}

describe("the display's clock", () => {
  it("picks the frame the wall clock is actually in", async () => {
    const start = 4_000_000;
    const s = await makeSession(start, 10);
    expect(frameAt(s, start * STEP)!.step).toBe(start);
    expect(frameAt(s, start * STEP + STEP - 1)!.step).toBe(start); // still inside the first slice
    expect(frameAt(s, (start + 1) * STEP)!.step).toBe(start + 1);
    expect(frameAt(s, (start + 9) * STEP)!.step).toBe(start + 9);
  });

  it("goes dark rather than looping when the session is over", async () => {
    const start = 4_000_000;
    const s = await makeSession(start, 10);
    expect(frameAt(s, (start + 10) * STEP)).toBeNull();
    expect(frameAt(s, (start - 1) * STEP)).toBeNull();
    // A session with no frames must not crash the render loop.
    expect(frameAt({ ...s, frames: [] }, start * STEP)).toBeNull();
  });

  it("derives the frame from the CLOCK, not from a counter — so it cannot drift", async () => {
    const start = 4_000_000;
    const s = await makeSession(start, 20);
    // Jump straight to the middle, as a backgrounded tab does when it wakes up. A cursor
    // incremented per animation frame would be far behind; this lands exactly right.
    expect(frameAt(s, (start + 13) * STEP + 5)!.step).toBe(start + 13);
    expect(frameAt(s, (start + 13) * STEP + 5)!.code).toBe(s.frames[13]!.code);
  });

  it("sweeps the countdown ring exactly once per session", async () => {
    const start = 4_000_000;
    const s = await makeSession(start, 10);
    expect(sessionProgress(s, start * STEP)).toBe(0);
    expect(sessionProgress(s, (start + 5) * STEP)).toBeCloseTo(0.5, 1);
    expect(sessionProgress(s, (start + 10) * STEP)).toBe(1);
    // Clamped, so a stale session reads as full instead of overflowing the arc.
    expect(sessionProgress(s, (start + 99) * STEP)).toBe(1);
    expect(sessionProgress(s, 0)).toBe(0);
  });

  it("renews EARLY, so the roll into the next session is seamless", async () => {
    const start = 4_000_000;
    const s = await makeSession(start, 75); // ~30s at 400ms
    const endMs = (start + 75) * STEP;
    expect(shouldRenew(s, endMs - 10_000)).toBe(false);
    expect(shouldRenew(s, endMs - 1000)).toBe(true);
    expect(shouldRenew(s, endMs)).toBe(true);
  });
});

describe("the scanner's collector", () => {
  const frame = (step: number, code = `c${step}`) => ({ sessionId: "sess", step, code });

  it("needs a contiguous run before it will submit", () => {
    const c = new FrameCollector(4);
    expect(c.state).toBe("watching");
    expect(c.push(frame(100))).toBe("watching");
    expect(c.push(frame(101))).toBe("watching");
    expect(c.push(frame(102))).toBe("watching");
    expect(c.progress).toBeCloseTo(0.75);
    expect(c.push(frame(103))).toBe("ready");
    expect(c.captured.map((f) => f.step)).toEqual([100, 101, 102, 103]);
  });

  it("treats a stuck camera as ONE sighting, not forty", () => {
    const c = new FrameCollector(4);
    for (let i = 0; i < 40; i++) c.push(frame(100));
    expect(c.state).toBe("watching");
    expect(c.captured).toHaveLength(1);
  });

  it("restarts the run on a gap rather than sending a hole", () => {
    const c = new FrameCollector(4);
    c.push(frame(100));
    c.push(frame(101));
    c.push(frame(105)); // the camera missed three frames
    expect(c.captured.map((f) => f.step)).toEqual([105]);
    c.push(frame(106));
    c.push(frame(107));
    expect(c.push(frame(108))).toBe("ready");
    expect(c.captured.map((f) => f.step)).toEqual([105, 106, 107, 108]);
  });

  it("restarts cleanly when the ambassador's display rolls to a new session", () => {
    // This happens every 30 seconds by design, and treating it as an error would make a
    // perfectly good scan fail for no reason the user could see.
    const c = new FrameCollector(4);
    c.push(frame(100));
    c.push(frame(101));
    c.push({ sessionId: "next-session", step: 500, code: "x" });
    expect(c.session).toBe("next-session");
    expect(c.captured.map((f) => f.step)).toEqual([500]);
  });

  it("does not grow without bound during a long scan", () => {
    const c = new FrameCollector(4);
    for (let i = 0; i < 500; i++) c.push(frame(1000 + i));
    expect(c.captured.length).toBeLessThanOrEqual(12);
    expect(c.state).toBe("ready"); // and it's still ready to submit
  });

  it("ignores garbage without throwing — a camera decodes plenty of noise", () => {
    const c = new FrameCollector(4);
    for (const junk of [null, undefined, { sessionId: "s", step: NaN, code: "x" }, { sessionId: "s", step: 1, code: "" }]) {
      expect(() => c.push(junk as any)).not.toThrow();
    }
    expect(c.captured).toHaveLength(0);
  });

  it("resets on demand, for a retry after the server said no", () => {
    const c = new FrameCollector(4);
    c.push(frame(100));
    c.push(frame(101));
    c.reset();
    expect(c.captured).toHaveLength(0);
    expect(c.session).toBeNull();
    expect(c.progress).toBe(0);
  });
});

describe("what the camera decodes", () => {
  it("reads back exactly what the display encoded", async () => {
    const s = await makeSession(4_000_000, 5);
    const decoded = parseFrameUrl(s.frames[2]!.payload);
    expect(decoded).toEqual({ sessionId: "sess", step: s.frames[2]!.step, code: s.frames[2]!.code });
  });

  it("rejects anything that isn't one of our frames", () => {
    for (const junk of ["", "not a url", "https://thebay.events/j", "https://evil.example/j#s=a&t=1", "https://thebay.events/j#t=1&c=x"]) {
      expect(parseFrameUrl(junk), junk).toBeNull();
    }
  });

  it("survives a QR from some other product entirely", () => {
    // People point cameras at all sorts of things. Every one of these must be a no-op.
    for (const other of ["WIFI:S:MyNetwork;T:WPA;P:hunter2;;", "BEGIN:VCARD\nEND:VCARD", "tel:+14155551212", "https://example.com/promo?ref=x"]) {
      expect(parseFrameUrl(other)).toBeNull();
    }
  });
});

describe("the /j short link", () => {
  it("sends a stock camera app to the scanner, keeping the frame it caught", async () => {
    // Every frame's QR encodes `/j#s=…&t=…&c=…`, kept short so the code stays low-density
    // enough to read at 400ms per frame. A 302 with no fragment of its own preserves the
    // original fragment, so an iPhone user whose Camera app catches one frame lands on the
    // scanner already holding it — not enough to get in, but enough to get started.
    const worker = (await import("../src/worker/index")).default;
    const { env } = await import("./helpers/app").then((m) => m.makeTestEnv());
    const res = await worker.fetch(new Request("https://thebay.events/j"), env as any, {} as any);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app/handshake");
    // And it must not have swallowed the SPA's own entry point.
    const app = await worker.fetch(new Request("https://thebay.events/app"), env as any, {} as any);
    expect(app.headers.get("location")).toBe("/app/");
  });
});
