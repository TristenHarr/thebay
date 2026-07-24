import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import QRCode from "qrcode";
import { useGetMeQuery, useGetEventFullQuery, useIssueCheckinTokenMutation, useCheckInMutation, useGetCheckinsQuery } from "../../api";
import { Button, Card, Spinner, PageHeader, Avatar } from "../../ui/kit";

const RESULT_COPY: Record<string, { icon: string; title: string; sub: string; tone: string }> = {
  ok: { icon: "✅", title: "You're checked in!", sub: "+20 points · your attendance streak advanced.", tone: "text-ok" },
  already: { icon: "👍", title: "Already checked in", sub: "You were on the list already — enjoy the event.", tone: "text-ok" },
  invalid: { icon: "⚠️", title: "Invalid code", sub: "That QR isn't for this event. Ask the host to show it again.", tone: "text-warn" },
  expired: { icon: "⏳", title: "Code expired", sub: "The door code rotated. Scan the current QR at the entrance.", tone: "text-warn" },
};

/** Attendee scan target + host door screen. One route, /event/:id/checkin. */
export function Checkin({ me }: { me: any }) {
  const { id = "" } = useParams();
  const [sp] = useSearchParams();
  const scannedToken = sp.get("token");
  const { data: full, isLoading } = useGetEventFullQuery(id, { skip: !id });
  const isHost = !!me && full?.host?.id === me.id;

  if (isLoading) return <Spinner />;
  if (scannedToken) return <AttendeeScan eventId={id} token={scannedToken} title={full?.event?.title} />;
  if (isHost) return <HostDoor eventId={id} title={full?.event?.title} />;
  return <AttendeeWaiting eventId={id} title={full?.event?.title} />;
}

function AttendeeScan({ eventId, token, title }: { eventId: string; token: string; title?: string }) {
  const [checkIn] = useCheckInMutation();
  const [result, setResult] = useState<string | null>(null);
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return; ran.current = true;
    checkIn({ eventId, token }).then((r: any) => setResult(r.data?.result ?? r.error?.data?.result ?? "invalid"));
  }, [eventId, token, checkIn]);

  if (!result) return <div className="py-16 text-center"><Spinner /><p className="mt-3 text-muted">Checking you in…</p></div>;
  const c = RESULT_COPY[result] || RESULT_COPY.invalid!;
  return (
    <div data-testid="checkin-result" className="py-10 text-center">
      <div className="text-6xl">{c.icon}</div>
      <h1 className={`mt-4 text-2xl font-bold ${c.tone}`}>{c.title}</h1>
      <p className="mt-1 text-muted">{c.sub}</p>
      {title && <p className="mt-1 font-mono text-sm text-muted">{title}</p>}
      <div className="mt-6 flex justify-center gap-2">
        <Link to={`/event/${eventId}`}><Button variant="ghost">Event details</Button></Link>
        {(result === "ok" || result === "already") && <Link to="/goals"><Button>Set your goal for tonight →</Button></Link>}
      </div>
    </div>
  );
}

function AttendeeWaiting({ eventId, title }: { eventId: string; title?: string }) {
  return (
    <div data-testid="checkin-waiting" className="py-10 text-center">
      <div className="text-5xl">📷</div>
      <h1 className="mt-4 text-xl font-bold">Scan the QR at the door</h1>
      <p className="mt-1 text-muted">Point your phone camera at the check-in code the host is showing{title ? ` for ${title}` : ""}.</p>
      <div className="mt-6"><Link to={`/event/${eventId}`}><Button variant="ghost">Back to event</Button></Link></div>
    </div>
  );
}

function HostDoor({ eventId, title }: { eventId: string; title?: string }) {
  const [issue] = useIssueCheckinTokenMutation();
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { data: roster, refetch } = useGetCheckinsQuery(eventId, { pollingInterval: 5000 });

  async function newCode() {
    setErr(null);
    const r: any = await issue(eventId);
    if (!r.data?.token) { setErr("Only the host can open check-in."); return; }
    const url = `${window.location.origin}/app/event/${eventId}/checkin?token=${r.data.token}`;
    const png = await QRCode.toDataURL(url, { width: 320, margin: 1, color: { dark: "#0a0a0f", light: "#ffffff" } });
    setDataUrl(png);
  }
  useEffect(() => { newCode(); /* issue an initial code on open */ /* eslint-disable-next-line */ }, [eventId]);

  return (
    <div data-testid="checkin-host">
      <PageHeader title="Door check-in" sub={title ? `Attendees scan to check in to ${title}.` : "Attendees scan to check in."} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="flex flex-col items-center gap-3 p-5">
          {dataUrl ? <img src={dataUrl} alt="Check-in QR code" className="w-full max-w-[280px] rounded-lg" /> : <div className="flex h-64 w-full items-center justify-center"><Spinner /></div>}
          {err && <p className="text-sm text-warn">{err}</p>}
          <Button variant="ghost" onClick={newCode}>↻ Rotate code</Button>
          <p className="text-center text-xs text-muted">Codes rotate for security. Keep this on screen at the entrance.</p>
        </Card>
        <Card className="p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold">Checked in</h3>
            <span className="font-mono text-2xl font-bold text-ok">{roster?.count ?? 0}</span>
          </div>
          <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
            {(roster?.checkins || []).map((p: any) => (
              <div key={p.userId} className="flex items-center gap-2 text-sm">
                <Avatar user={{ displayName: p.displayName }} size={26} />
                <span className="flex-1 truncate">{p.displayName}</span>
                <span className="font-mono text-xs text-muted">{new Date(p.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
            ))}
            {!roster?.count && <p className="text-sm text-muted">No check-ins yet — they'll appear here live.</p>}
          </div>
          <Button variant="quiet" className="mt-3 w-full" onClick={() => refetch()}>Refresh</Button>
        </Card>
      </div>
    </div>
  );
}
