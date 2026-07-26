import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { useGetNetMeQuery, useStartHandshakeMutation, useJoinNetworkMutation } from "../../api";
import { Button, Card, PageHeader, Spinner, Badge, cx } from "../../ui/kit";
import { FrameCollector, frameAt, parseFrameUrl, sessionProgress, shouldRenew, type Session } from "./useHandshake";

/**
 * The handshake — how anyone gets into the scrape network, and how two members connect.
 *
 * One screen with two sides, because it is one physical act. A member presses **Show** and
 * their phone plays a short film: a ring of orbs orbiting a code that changes every 400ms.
 * The other person presses **Scan** and points their camera at it for about a second and a
 * half. That's it.
 *
 * The animation is not decoration — it IS the credential. Each frame carries an
 * HMAC-derived code for its own 400ms slice of the wall clock, and the server requires four
 * CONSECUTIVE frames, recent, to admit anybody (src/core/net/handshake.ts). So a screenshot
 * is one frame of four, a screen recording has steps already in the past, and getting in
 * genuinely requires having been there. The orbs' rotation is locked to the frame index, so
 * the thing you watch moving is the thing being verified.
 *
 * The display drives itself off `Date.now()` against the server's absolute step boundaries
 * rather than a local timer, because a local cursor drifts and a drifting display shows
 * codes the server has already retired.
 */

type Mode = "idle" | "show" | "scan";

/** Where the pair is standing. Both sides need it: the server checks each against the Bay
 *  and against each other, which is what stops a leaked frame list working from elsewhere. */
function useFix() {
  const [fix, setFix] = useState<{ lat: number; lng: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ask = useCallback(() => {
    if (!navigator.geolocation) return setError("this device can't share its location, which the handshake needs");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setFix({ lat: p.coords.latitude, lng: p.coords.longitude });
        setError(null);
      },
      (e) => setError(e.code === e.PERMISSION_DENIED ? "location is required — the handshake proves you're together" : "couldn't get a location fix"),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  }, []);
  return { fix, error, ask };
}

/* ─────────────────────────────── Show ──────────────────────────────────────── */

const ORBS = 12;

/**
 * The ring. Twelve orbs on a circle, their phase advanced by the frame index and their
 * brightness following the same rotation — so the ring visibly *ticks* once per frame and a
 * viewer can tell at a glance whether the film is playing or has stalled.
 */
function OrbRing({ step, progress }: { step: number; progress: number }) {
  const spin = (step % ORBS) * (360 / ORBS);
  return (
    <svg viewBox="-60 -60 120 120" className="absolute inset-0 h-full w-full" aria-hidden>
      {/* Session countdown: one sweep per session, so "it's about to roll" is visible. */}
      <circle cx="0" cy="0" r="55" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-black/5 dark:text-white/10" />
      <circle
        cx="0"
        cy="0"
        r="55"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-accent"
        strokeDasharray={`${2 * Math.PI * 55}`}
        strokeDashoffset={`${2 * Math.PI * 55 * (1 - progress)}`}
        transform="rotate(-90)"
        strokeLinecap="round"
      />
      <g transform={`rotate(${spin})`}>
        {Array.from({ length: ORBS }, (_, i) => {
          const a = (i / ORBS) * Math.PI * 2;
          // A comet tail: the orb at the head of the rotation is brightest.
          const lead = (ORBS - i) / ORBS;
          return (
            <circle
              key={i}
              cx={Math.cos(a) * 46}
              cy={Math.sin(a) * 46}
              r={2 + lead * 2.5}
              className="fill-accent"
              opacity={0.15 + lead * 0.85}
            />
          );
        })}
      </g>
    </svg>
  );
}

function ShowSide({ onDone }: { onDone: () => void }) {
  const { fix, error: fixError, ask } = useFix();
  const [start, { error: startError }] = useStartHandshakeMutation();
  const [session, setSession] = useState<Session | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [qr, setQr] = useState<string>("");
  const renewing = useRef(false);

  useEffect(() => {
    ask();
  }, [ask]);

  const open = useCallback(
    async (at: { lat: number; lng: number }) => {
      if (renewing.current) return;
      renewing.current = true;
      try {
        const s = await start(at).unwrap();
        setSession(s as Session);
      } catch {
        /* the error surfaces through `startError`; the ring simply stops */
      } finally {
        renewing.current = false;
      }
    },
    [start],
  );

  useEffect(() => {
    if (fix && !session) void open(fix);
  }, [fix, session, open]);

  // One rAF loop drives everything: which frame is due, the countdown ring, and rolling
  // seamlessly into the next session before this one runs out.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      if (session && fix && shouldRenew(session, t)) void open(fix);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [session, fix, open]);

  const frame = useMemo(() => (session ? frameAt(session, now) : null), [session, now]);

  // Regenerate the QR only when the frame actually changes — 2.5 times a second, not 60.
  useEffect(() => {
    if (!frame) return;
    let live = true;
    QRCode.toString(frame.payload, { type: "svg", errorCorrectionLevel: "M", margin: 0 })
      .then((svg: string) => {
        if (live) setQr(svg);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [frame?.payload]);

  const err = fixError || (startError ? ((startError as any)?.data?.error ?? "couldn't start a handshake") : null);

  return (
    <Card className="p-6" data-testid="handshake-show">
      {err ? (
        <div className="py-10 text-center">
          <p className="text-sm text-muted">{err}</p>
          <Button className="mt-4" onClick={ask}>
            Try again
          </Button>
        </div>
      ) : !session || !frame ? (
        <div className="py-16 text-center">
          <Spinner />
          <p className="mt-3 text-sm text-muted">{fix ? "starting the handshake…" : "getting your location…"}</p>
        </div>
      ) : (
        <>
          <div className="relative mx-auto aspect-square w-full max-w-[22rem]">
            <OrbRing step={frame.step} progress={sessionProgress(session, now)} />
            {/* The code itself, inside the ring. */}
            <div
              className="absolute inset-[22%] [&>svg]:h-full [&>svg]:w-full"
              // The SVG comes from `qrcode`, generated locally from a URL we just built —
              // no user input reaches it.
              dangerouslySetInnerHTML={{ __html: qr }}
              data-testid="handshake-frame"
              data-step={frame.step}
            />
          </div>
          <p className="mt-5 text-center text-sm font-medium">Hold this up to them</p>
          <p className="mx-auto mt-1 max-w-sm text-center text-xs text-muted">
            The code is moving, so a photo of it is worthless. They point their camera at it for a second or two.
          </p>
          <Button variant="ghost" className="mx-auto mt-5 block" onClick={onDone}>
            Done
          </Button>
        </>
      )}
    </Card>
  );
}

/* ─────────────────────────────── Scan ──────────────────────────────────────── */

/**
 * Decode one video frame. Prefers the browser's native `BarcodeDetector` (Chrome, Android) and
 * falls back to jsQR everywhere else — which is not a nicety: `BarcodeDetector` does not exist
 * on iOS Safari, and a Bay Area in-person product where iPhone users cannot join would be
 * useless.
 */
async function decodeFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement, detector: any | null): Promise<string | null> {
  if (detector) {
    try {
      const found = await detector.detect(video);
      if (found?.length) return found[0].rawValue ?? null;
    } catch {
      /* fall through to jsQR — a detector that throws once usually keeps throwing */
    }
  }
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);
  const found = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" });
  return found?.data ?? null;
}

function ScanSide({ onJoined }: { onJoined: () => void }) {
  const { fix, error: fixError, ask } = useFix();
  const [join, { isLoading }] = useJoinNetworkMutation();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<string>("point your camera at their screen");
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState<{ tier: string; vouchedBy: { handle: string } | null } | null>(null);
  const submitting = useRef(false);

  useEffect(() => {
    ask();
  }, [ask]);

  useEffect(() => {
    if (!fix) return;
    let stream: MediaStream | null = null;
    let stop = false;
    // Four frames is the requirement; the collector knows the number, not this component.
    const collector = new FrameCollector(4);
    const detector = typeof (window as any).BarcodeDetector !== "undefined" ? new (window as any).BarcodeDetector({ formats: ["qr_code"] }) : null;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      } catch {
        setError("camera access is needed to read their screen");
        return;
      }
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return;
      video.srcObject = stream;
      await video.play().catch(() => {});

      // ~15fps: fast enough to catch every 400ms frame several times over, slow enough not
      // to melt a phone. The bottleneck is jsQR on the fallback path.
      while (!stop) {
        const text = await decodeFrame(video, canvas, detector);
        const decoded = text ? parseFrameUrl(text) : null;
        if (decoded) {
          const state = collector.push(decoded);
          setProgress(collector.progress);
          setStatus(state === "ready" ? "got it — joining…" : "hold steady…");
          if (state === "ready" && !submitting.current) {
            submitting.current = true;
            try {
              const r = await join({ sessionId: collector.session!, frames: collector.captured, ...fix }).unwrap();
              setJoined({ tier: r.tier, vouchedBy: r.vouchedBy });
              stop = true;
              break;
            } catch (e: any) {
              // A reason the server gave us — "stand next to each other", "that took too
              // long". Keep filming: most of these are recoverable in place.
              setError(e?.data?.error ?? "that didn't work");
              collector.reset();
              setProgress(0);
              submitting.current = false;
            }
          }
        }
        await new Promise((r) => setTimeout(r, 66));
      }
    })();

    return () => {
      stop = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [fix, join]);

  if (joined) {
    return (
      <Card className="p-8 text-center" data-testid="handshake-joined">
        <div className="text-4xl">🤝</div>
        <h3 className="mt-3 text-lg font-semibold">You're in</h3>
        <p className="mt-1 text-sm text-muted">
          {joined.vouchedBy ? `@${joined.vouchedBy.handle} vouched for you.` : "Welcome."} You're a{" "}
          <Badge>{joined.tier}</Badge> member — your finds count once another worker confirms them.
        </p>
        <Button className="mt-5" onClick={onJoined}>
          See what to do next
        </Button>
      </Card>
    );
  }

  return (
    <Card className="p-6" data-testid="handshake-scan">
      {fixError ? (
        <div className="py-10 text-center">
          <p className="text-sm text-muted">{fixError}</p>
          <Button className="mt-4" onClick={ask}>
            Try again
          </Button>
        </div>
      ) : (
        <>
          <div className="relative mx-auto aspect-square w-full max-w-[22rem] overflow-hidden rounded-2xl bg-black/80">
            <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
            <canvas ref={canvasRef} className="hidden" />
            {/* Capture progress: four frames, filling as they land. */}
            <div className="absolute inset-x-0 bottom-0 h-1.5 bg-white/20">
              <div className="h-full bg-accent transition-[width] duration-150" style={{ width: `${progress * 100}%` }} />
            </div>
          </div>
          <p className="mt-5 text-center text-sm font-medium">{isLoading ? "joining…" : status}</p>
          {error ? <p className="mt-2 text-center text-xs text-warn">{error}</p> : null}
          <p className="mx-auto mt-1 max-w-sm text-center text-xs text-muted">
            The code on their screen keeps changing. Hold the camera on it until the bar fills.
          </p>
        </>
      )}
    </Card>
  );
}

/* ─────────────────────────────── the screen ────────────────────────────────── */

export default function Handshake({ me }: { me: any }) {
  const { data, isLoading } = useGetNetMeQuery(undefined, { skip: !me });
  const [mode, setMode] = useState<Mode>("idle");

  // A newcomer's only option is Scan; a member who can vouch gets both. Deciding this from
  // `canVouch` rather than from a tier string keeps the rule in one place — the server's.
  const canVouch = !!data?.canVouch;
  const isMember = !!data?.member;

  if (!me) {
    return (
      <div className="mx-auto max-w-2xl p-4" data-testid="handshake">
        <PageHeader title="Handshake" sub="Sign in first — you join the network as yourself." />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl p-4" data-testid="handshake">
      <PageHeader
        title="Handshake"
        sub={
          isMember
            ? "Meet in person: one of you shows the moving code, the other watches it."
            : "The only way into the scrape network is to meet a member in person."
        }
      />

      {isLoading ? (
        <div className="py-16 text-center">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="mb-4 flex gap-2">
            {canVouch ? (
              <Button
                className={cx("flex-1", mode === "show" && "ring-2 ring-accent")}
                onClick={() => setMode(mode === "show" ? "idle" : "show")}
                data-testid="handshake-show-btn"
              >
                Show
              </Button>
            ) : null}
            <Button
              variant={canVouch ? "ghost" : "primary"}
              className={cx("flex-1", mode === "scan" && "ring-2 ring-accent")}
              onClick={() => setMode(mode === "scan" ? "idle" : "scan")}
              data-testid="handshake-scan-btn"
            >
              Scan
            </Button>
          </div>

          {mode === "show" ? <ShowSide onDone={() => setMode("idle")} /> : null}
          {mode === "scan" ? <ScanSide onJoined={() => setMode("idle")} /> : null}
          {mode === "idle" ? (
            <Card className="p-6">
              <h3 className="text-sm font-semibold">Why it works this way</h3>
              <p className="mt-2 text-sm text-muted">
                Anyone who contributes to the catalog can publish to it, so an account has to be expensive to get.
                Meeting somebody is the only cost that doesn't scale for a spammer. The code on screen changes every
                fraction of a second and your phone has to see several in a row, so a screenshot or a recording is
                worth nothing — you have to actually be standing there.
              </p>
              {isMember && !canVouch ? (
                <p className="mt-3 text-xs text-muted">
                  You'll be able to vouch for people once you're <Badge>trusted</Badge>
                  {data?.nextTier ? ` — ${data.nextTier.minConfirms} confirmed finds across ${data.nextTier.minDays} days` : null}.
                </p>
              ) : null}
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
