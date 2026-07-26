import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import QRCode from "qrcode";
import { useGetEventFullQuery, useGetMeQuery, useMintDoorCodeMutation, useClaimPresenceMutation } from "../../api";
import { Button, Card, Spinner, PageHeader } from "../../ui/kit";
import { parseDoorHash } from "../../../../src/core/gym/presence";
import { inBay } from "../../../../src/core/geo";

/**
 * The hardened door. One route, two audiences — exactly like the check-in screen.
 *
 * **The host** sees a QR that re-mints itself every `rotateMs`, each new code revoking the
 * one before it. That rotation is not decoration: it is what makes a photograph of the
 * screen worthless, and it is why the TTL can be 90 seconds without the door going dark.
 *
 * **An attendee** arrives with the secret in the URL FRAGMENT (never the query string, so
 * it stays out of request logs and `Referer`), and their browser must supply a GPS fix
 * within 150 m of where the host stood. That fix is the thing that makes host-awarded XP
 * unfarmable: without it, a forwarded link would mint attendance from anywhere.
 */

const RESULT_TONE: Record<string, string> = { ok: "text-ok", expired: "text-warn", revoked: "text-warn" };

export function Door({ me }: { me: any }) {
  const { id = "" } = useParams();
  const { data: full, isLoading } = useGetEventFullQuery(id, { skip: !id });
  const { data: meData } = useGetMeQuery();
  const scanned = parseDoorHash(typeof window === "undefined" ? "" : window.location.hash);
  const isHost = !!(me || meData?.user) && full?.host?.id === (me?.id ?? meData?.user?.id);

  if (isLoading) return <Spinner />;
  if (scanned) return <AttendeeClaim eventId={id} codeId={scanned.codeId} secret={scanned.secret} title={full?.event?.title} />;
  if (isHost) return <HostDoor eventId={id} title={full?.event?.title} />;
  return (
    <div data-testid="gym-door" className="py-10 text-center">
      <div className="text-5xl">📷</div>
      <h1 className="mt-4 text-xl font-bold">Scan the door code</h1>
      <p className="mt-1 text-muted">
        Point your camera at the QR the host is showing{full?.event?.title ? ` for ${full.event.title}` : ""}. You need to be at the venue.
      </p>
      <div className="mt-6">
        <Link to={`/event/${id}`}>
          <Button variant="ghost">Back to event</Button>
        </Link>
      </div>
    </div>
  );
}

function AttendeeClaim({ eventId, codeId, secret, title }: { eventId: string; codeId: string; secret: string; title?: string }) {
  const [claim] = useClaimPresenceMutation();
  const [state, setState] = useState<{ result: string; message: string } | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (!navigator.geolocation) {
      setState({ result: "too_far", message: "This device can't share its location, so we can't verify you're here." });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        // Check locally first so an obviously-out-of-region scan gets an instant, honest
        // answer instead of a round trip. The server checks again — this is a courtesy,
        // never the guard.
        if (!inBay(lat, lng)) {
          setState({ result: "out_of_region", message: "Door check-in only works in the Bay Area." });
          return;
        }
        const r: any = await claim({ eventId, codeId, secret, lat, lng });
        const body = r.data ?? r.error?.data ?? {};
        setState({ result: body.result ?? "expired", message: body.message ?? "That code didn't work — scan the one on screen now." });
      },
      () => setState({ result: "too_far", message: "We need your location to confirm you're at the venue." }),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }, [eventId, codeId, secret, claim]);

  if (!state) {
    return (
      <div data-testid="gym-door" className="py-16 text-center">
        <Spinner />
        <p className="mt-3 text-muted">Checking you in…</p>
      </div>
    );
  }
  return (
    <div data-testid="gym-door" className="py-10 text-center">
      <div className="text-6xl">{state.result === "ok" ? "✅" : "⚠️"}</div>
      <h1 className={`mt-4 text-2xl font-bold ${RESULT_TONE[state.result] ?? "text-warn"}`}>
        {state.result === "ok" ? "You're in" : "Couldn't check you in"}
      </h1>
      <p className="mt-1 text-muted">{state.message}</p>
      {title && <p className="mt-1 font-mono text-sm text-muted">{title}</p>}
      {state.result === "ok" && (
        <p className="mx-auto mt-4 max-w-sm text-sm text-muted">
          Scan again later in the evening to log how long you stayed — hosts can reward time in the room.
        </p>
      )}
      <div className="mt-6 flex justify-center gap-2">
        <Link to={`/event/${eventId}`}>
          <Button variant="ghost">Event details</Button>
        </Link>
      </div>
    </div>
  );
}

function HostDoor({ eventId, title }: { eventId: string; title?: string }) {
  const [mint] = useMintDoorCodeMutation();
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fix = useRef<{ lat: number; lng: number } | null>(null);
  const [rotateMs, setRotateMs] = useState(30_000);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let live = true;

    async function newCode() {
      if (!fix.current) return;
      const r: any = await mint({ eventId, ...fix.current });
      if (!live) return;
      if (!r.data?.url) {
        setErr(r.error?.data?.error ?? "Couldn't open the door.");
        return;
      }
      setErr(null);
      setRotateMs(r.data.rotateMs || 30_000);
      setDataUrl(await QRCode.toDataURL(r.data.url, { width: 340, margin: 1, color: { dark: "#0a0a0f", light: "#ffffff" } }));
    }

    // The host's own GPS is the geofence origin — `events.latitude` is unusable here,
    // because /api/host never collects coordinates and most scraped venues aren't geocoded.
    if (!navigator.geolocation) {
      setErr("This device can't share its location, so it can't open a verified door.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        fix.current = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        void newCode();
        timer = setInterval(newCode, rotateMs);
      },
      () => setErr("We need your location to open the door — it's what proves attendees are actually here."),
      { enableHighAccuracy: true, timeout: 10_000 },
    );

    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [eventId]);

  return (
    <div data-testid="gym-door">
      <PageHeader
        title="Door"
        sub={title ? `Attendees scan this to check in to ${title}.` : "Attendees scan this to check in."}
        right={
          <Link className="font-mono text-sm text-accent hover:underline" to={`/event/${eventId}/gym`}>
            ← Gym
          </Link>
        }
      />
      <Card className="flex flex-col items-center gap-3 p-5">
        {dataUrl ? (
          <img src={dataUrl} alt="Door check-in QR code" className="w-full max-w-[300px] rounded-lg" />
        ) : (
          <div className="flex h-72 w-full items-center justify-center">{err ? <span className="text-sm text-warn">{err}</span> : <Spinner />}</div>
        )}
        {dataUrl && err && <p className="text-sm text-warn">{err}</p>}
        <p className="max-w-sm text-center text-xs text-muted">
          This code changes every {Math.round(rotateMs / 1000)} seconds and only works within about 150 m of where you're standing — so a
          screenshot is useless to anyone who isn't here. Keep it on screen at the entrance.
        </p>
      </Card>
    </div>
  );
}
