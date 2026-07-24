import { render } from "preact";
import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import { api, imgUrl } from "./api";

/* ─────────────────────────── helpers ─────────────────────────── */
const fmtDate = (iso: string, tz = "America/Los_Angeles") => {
  try {
    return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso));
  } catch { return iso; }
};
const initials = (name: string) => name.split(/\s+/).map((s) => s[0]).join("").slice(0, 2).toUpperCase();

function Avatar({ user, size = 32 }: { user: { displayName: string; avatarKey?: string | null }; size?: number }) {
  const url = imgUrl(user.avatarKey);
  return url ? (
    <img class="avatar" src={url} width={size} height={size} style={{ width: size, height: size }} alt={user.displayName} />
  ) : (
    <span class="avatar avatar-fallback" style={{ width: size, height: size, fontSize: size * 0.4 }}>{initials(user.displayName)}</span>
  );
}

/* ─────────────────────────── router ─────────────────────────── */
function useRoute() {
  const [hash, setHash] = useState(location.hash.slice(1) || "/");
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1) || "/");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash;
}
const go = (path: string) => { location.hash = path; };
const Link = ({ href, children, class: cls }: any) => (
  <a href={"#" + href} class={cls}>{children}</a>
);

/* ─────────────────────────── auth store ─────────────────────────── */
function useAuth() {
  const [me, setMe] = useState<any>(undefined); // undefined = loading, null = anon
  const [points, setPoints] = useState(0);
  const refresh = useCallback(async () => {
    const r = await api.me();
    setMe(r.user ?? null);
    setPoints(r.points ?? 0);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return { me, points, refresh, setMe };
}

/* ─────────────────────────── sign in ─────────────────────────── */
function SignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");
  const dev = /localhost|127\.0\.0\.1/.test(location.host);
  return (
    <div class="card auth-card">
      <h2>Sign in to The Bay</h2>
      <p class="muted">Discover events, see where your friends are going, and coordinate.</p>
      <div class="oauth">
        <a class="btn oauth-btn" href="/auth/google/start">Continue with Google</a>
        <a class="btn oauth-btn" href="/auth/github/start">Continue with GitHub</a>
      </div>
      <div class="divider">or</div>
      <form onSubmit={async (e) => {
        e.preventDefault();
        const r = await api.emailLogin(email);
        if (r.devLink) { setMsg("Dev link ready — opening…"); location.href = r.devLink; }
        else setMsg("Check your email for a sign-in link.");
      }}>
        <input class="input" type="email" placeholder="you@email.com" value={email} onInput={(e: any) => setEmail(e.target.value)} required />
        <button class="btn btn-primary" type="submit">Email me a link</button>
      </form>
      {msg && <p class="muted">{msg}</p>}
      {dev && (
        <div class="devbox">
          <p class="muted">Dev quick-login:</p>
          <button class="btn" onClick={async () => { await api.devLogin("you@test.com", "You"); onDone(); }}>Log in as “You”</button>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────── RSVP control ─────────────────────────── */
function RsvpButtons({ eventId, value, onChange }: { eventId: string; value: string; onChange: (s: string, pts?: number) => void }) {
  const opts: [string, string][] = [["going", "Going"], ["interested", "Interested"], ["none", "Not going"]];
  return (
    <div class="rsvp">
      {opts.map(([v, label]) => (
        <button class={"chip" + (value === v ? " on" : "")} onClick={async () => {
          const r = await api.rsvp(eventId, v as any);
          onChange(r.status ?? v, r.points);
        }}>{label}</button>
      ))}
    </div>
  );
}

function FriendPips({ friends }: { friends: any[] }) {
  if (!friends?.length) return null;
  return (
    <div class="pips" title={friends.map((f) => f.displayName).join(", ")}>
      {friends.slice(0, 4).map((f) => <Avatar user={f} size={22} />)}
      <span class="pips-label">{friends.length} friend{friends.length > 1 ? "s" : ""} going</span>
    </div>
  );
}

/* ─────────────────────────── feed ─────────────────────────── */
function Feed({ me, refresh }: { me: any; refresh: () => void }) {
  const [events, setEvents] = useState<any[]>([]);
  const [friendMap, setFriendMap] = useState<Record<string, any[]>>({});
  const [mine, setMine] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<"all" | "friends">("all");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      if (tab === "friends" && me) {
        const r = await api.friendsFeed();
        setEvents((r.items ?? []).map((x: any) => x.event));
        setFriendMap(Object.fromEntries((r.items ?? []).map((x: any) => [x.event.id, x.friends])));
      } else {
        const r = await api.events("?limit=120");
        setEvents(r.events ?? []);
        if (me) {
          const f = await api.friendsFeed();
          setFriendMap(Object.fromEntries((f.items ?? []).map((x: any) => [x.event.id, x.friends])));
        }
      }
      setLoading(false);
    })();
  }, [tab, me]);

  return (
    <div>
      <div class="tabs">
        <button class={"tab" + (tab === "all" ? " on" : "")} onClick={() => setTab("all")}>All events</button>
        {me && <button class={"tab" + (tab === "friends" ? " on" : "")} onClick={() => setTab("friends")}>Friends going</button>}
      </div>
      {loading ? <p class="muted">Loading…</p> : events.length === 0 ? (
        <p class="muted">{tab === "friends" ? "No friends going to anything upcoming yet — add friends!" : "No events."}</p>
      ) : (
        <div class="feed">
          {events.map((e) => (
            <div class="card event-card">
              {e.imageUrl && <img class="event-thumb" src={e.imageUrl} alt="" loading="lazy" />}
              <div class="event-body">
                <div class="event-time">{fmtDate(e.startUtc, e.timezone)}</div>
                <h3><Link href={`/event/${e.id}`}>{e.title}</Link></h3>
                <div class="muted small">{[e.venueName, e.organizer].filter(Boolean).join(" · ")}</div>
                <div class="badges">{(e.categories || []).slice(0, 3).map((c: string) => <span class="badge">{c}</span>)}</div>
                <FriendPips friends={friendMap[e.id]} />
                {me && <RsvpButtons eventId={e.id} value={mine[e.id] || "none"} onChange={(s) => { setMine({ ...mine, [e.id]: s }); refresh(); }} />}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────── event page ─────────────────────────── */
function EventPage({ id, me, refresh }: { id: string; me: any; refresh: () => void }) {
  const [d, setD] = useState<any>(null);
  const [rating, setRating] = useState(5);
  const [reviewText, setReviewText] = useState("");
  const load = useCallback(async () => setD(await api.eventFull(id)), [id]);
  useEffect(() => { load(); }, [load]);
  if (!d || !d.event) return <p class="muted">Loading…</p>;
  const e = d.event;
  return (
    <div class="event-page">
      {e.imageUrl && <img class="hero" src={e.imageUrl} alt="" />}
      <h1>{e.title}</h1>
      <div class="muted">{fmtDate(e.startUtc, e.timezone)}{e.venueName ? ` · ${e.venueName}` : ""}</div>
      {d.host && <div class="host">Hosted by <Link href={`/u/${d.host.handle}`}><Avatar user={d.host} size={22} /> {d.host.displayName}</Link></div>}
      {e.url && <a class="btn" href={e.url} target="_blank" rel="noopener">Event link ↗</a>}
      {e.description && <p class="desc">{e.description}</p>}

      {me ? <RsvpButtons eventId={e.id} value={d.myRsvp} onChange={() => { load(); refresh(); }} /> : <Link href="/signin" class="btn btn-primary">Sign in to RSVP</Link>}

      <div class="stat-row">
        <span>{d.counts?.going || 0} going</span>
        <span>{d.counts?.interested || 0} interested</span>
      </div>

      {d.friends?.length > 0 && <div class="section"><h4>Your friends going</h4><div class="pips">{d.friends.map((f: any) => <Link href={`/u/${f.handle}`}><Avatar user={f} size={28} /></Link>)}</div></div>}

      <div class="section">
        <h4>Attendees ({d.attendees?.length || 0})</h4>
        <div class="pips">{(d.attendees || []).map((a: any) => <Link href={`/u/${a.handle}`}><Avatar user={a} size={28} /></Link>)}</div>
      </div>

      <div class="section">
        <h4>Photos</h4>
        <div class="photos">{(d.photos || []).map((p: any) => <img class="photo" src={imgUrl(p.key)!} alt={p.caption || ""} />)}</div>
        {me && (
          <label class="btn">📷 Add photo
            <input type="file" accept="image/*" hidden onChange={async (ev: any) => { const f = ev.target.files[0]; if (f) { await api.uploadPhoto(id, f); load(); } }} />
          </label>
        )}
      </div>

      <div class="section">
        <h4>Reviews</h4>
        {(d.reviews || []).map((r: any) => <div class="review"><b>{"★".repeat(r.rating)}</b> <span class="muted">{r.author}</span><div>{r.body}</div></div>)}
        {me && d.canReview && (
          <form class="review-form" onSubmit={async (ev) => { ev.preventDefault(); await api.review(id, rating, reviewText); setReviewText(""); load(); }}>
            <select value={rating} onChange={(e: any) => setRating(+e.target.value)}>{[5, 4, 3, 2, 1].map((n) => <option value={n}>{"★".repeat(n)}</option>)}</select>
            <input class="input" placeholder="Share how it was…" value={reviewText} onInput={(e: any) => setReviewText(e.target.value)} />
            <button class="btn btn-primary" type="submit">Post</button>
          </form>
        )}
      </div>

      {me && (
        <button class="btn" onClick={async () => { const r = await api.createGroup(`${e.title} crew`, e.id); if (r.id) go(`/group/${r.id}`); }}>
          + Create a group to coordinate
        </button>
      )}
    </div>
  );
}

/* ─────────────────────────── friends ─────────────────────────── */
function Friends() {
  const [d, setD] = useState<any>({ friends: [], pending: [] });
  const [handle, setHandle] = useState("");
  const [found, setFound] = useState<any>(null);
  const load = async () => setD(await api.friends());
  useEffect(() => { load(); }, []);
  return (
    <div>
      <h2>Friends</h2>
      <form class="search" onSubmit={async (e) => { e.preventDefault(); const r = await api.profile(handle.replace(/^@/, "")); setFound(r.profile ? r : { error: true }); }}>
        <input class="input" placeholder="find by @handle" value={handle} onInput={(e: any) => setHandle(e.target.value)} />
        <button class="btn">Find</button>
      </form>
      {found?.profile && (
        <div class="card row">
          <Avatar user={found.profile} /> <b>{found.profile.displayName}</b> @{found.profile.handle}
          <button class="btn btn-primary" onClick={async () => { await api.requestFriend(found.profile.id); setFound(null); }}>Add friend</button>
        </div>
      )}
      {found?.error && <p class="muted">No one found with that handle.</p>}

      {d.pending?.length > 0 && (
        <div class="section"><h4>Requests</h4>
          {d.pending.map((p: any) => (
            <div class="card row"><Avatar user={p} /> <b>{p.displayName}</b>
              <button class="btn btn-primary" onClick={async () => { await api.respondFriend(p.id, true); load(); }}>Accept</button>
              <button class="btn" onClick={async () => { await api.respondFriend(p.id, false); load(); }}>Decline</button>
            </div>
          ))}
        </div>
      )}
      <div class="section"><h4>Your friends ({d.friends?.length || 0})</h4>
        {(d.friends || []).map((f: any) => <Link href={`/u/${f.handle}`} class="card row"><Avatar user={f} /> <b>{f.displayName}</b> <span class="muted">@{f.handle}</span></Link>)}
        {d.friends?.length === 0 && <p class="muted">No friends yet — find people by @handle above.</p>}
      </div>
    </div>
  );
}

/* ─────────────────────────── groups + chat ─────────────────────────── */
function Groups() {
  const [groups, setGroups] = useState<any[]>([]);
  const [name, setName] = useState("");
  const load = async () => setGroups((await api.groups()).groups ?? []);
  useEffect(() => { load(); }, []);
  return (
    <div>
      <h2>Groups</h2>
      <form class="search" onSubmit={async (e) => { e.preventDefault(); const r = await api.createGroup(name); setName(""); if (r.id) go(`/group/${r.id}`); }}>
        <input class="input" placeholder="New group name…" value={name} onInput={(e: any) => setName(e.target.value)} />
        <button class="btn btn-primary">Create</button>
      </form>
      {groups.map((g) => <Link href={`/group/${g.id}`} class="card row"><b>{g.name}</b> <span class="muted">{g.members} member{g.members > 1 ? "s" : ""}</span></Link>)}
      {groups.length === 0 && <p class="muted">No groups yet. Create one, or make one from an event page.</p>}
    </div>
  );
}

function GroupChat({ id, me }: { id: string; me: any }) {
  const [d, setD] = useState<any>({ members: [], messages: [] });
  const [text, setText] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const scroll = () => setTimeout(() => { if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight; }, 30);

  useEffect(() => {
    (async () => { setD(await api.group(id)); scroll(); })();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/groups/${id}/ws`);
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        setD((prev: any) => ({ ...prev, messages: [...prev.messages, m] }));
        scroll();
      } catch { /* ignore */ }
    };
    return () => ws.close();
  }, [id]);

  const send = async (e: Event) => {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setText("");
    await api.sendMessage(id, body); // server persists + broadcasts (we render on the WS echo)
  };

  return (
    <div class="chat">
      <div class="chat-head">
        <Link href="/groups">← Groups</Link>
        <div class="pips">{d.members.map((m: any) => <Avatar user={m} size={24} />)}</div>
      </div>
      <div class="messages" ref={boxRef}>
        {d.messages.map((m: any) => (
          <div class={"msg" + (m.userId === me?.id ? " mine" : "")}>
            <span class="msg-author">{m.author}</span>
            <span class="msg-body">{m.body}</span>
          </div>
        ))}
        {d.messages.length === 0 && <p class="muted">No messages yet — say hi 👋</p>}
      </div>
      <form class="chat-input" onSubmit={send}>
        <input class="input" placeholder="Message…" value={text} onInput={(e: any) => setText(e.target.value)} />
        <button class="btn btn-primary">Send</button>
      </form>
    </div>
  );
}

/* ─────────────────────────── leaderboard ─────────────────────────── */
function Leaderboard({ me }: { me: any }) {
  const [rows, setRows] = useState<any[]>([]);
  const [scope, setScope] = useState<"global" | "friends">("global");
  useEffect(() => { (async () => setRows((await api.leaderboard(scope === "friends" ? "friends" : undefined)).rows ?? []))(); }, [scope]);
  return (
    <div>
      <h2>Leaderboard</h2>
      <div class="tabs">
        <button class={"tab" + (scope === "global" ? " on" : "")} onClick={() => setScope("global")}>Everyone</button>
        {me && <button class={"tab" + (scope === "friends" ? " on" : "")} onClick={() => setScope("friends")}>Friends</button>}
      </div>
      <ol class="board">
        {rows.map((r, i) => (
          <li class="card row">
            <span class="rank">{i + 1}</span><Avatar user={r} /><b><Link href={`/u/${r.handle}`}>{r.displayName}</Link></b>
            <span class="pts">{r.points} pts</span>
          </li>
        ))}
      </ol>
      {rows.length === 0 && <p class="muted">No one on the board yet — RSVP, post photos, and host to earn points.</p>}
    </div>
  );
}

/* ─────────────────────────── host ─────────────────────────── */
function Host() {
  const [f, setF] = useState<any>({ title: "", startUtc: "", venueName: "", description: "", url: "" });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <div>
      <h2>Host an event</h2>
      <form class="hostform" onSubmit={async (e) => {
        e.preventDefault();
        const payload = { ...f, startUtc: new Date(f.startUtc).toISOString() };
        if (!payload.url) delete payload.url;
        const r = await api.host(payload);
        if (r.id) go(`/event/${r.id}`); else alert("Could not create event");
      }}>
        <label>Title<input class="input" value={f.title} onInput={set("title")} required /></label>
        <label>Date & time<input class="input" type="datetime-local" value={f.startUtc} onInput={set("startUtc")} required /></label>
        <label>Venue<input class="input" value={f.venueName} onInput={set("venueName")} /></label>
        <label>Link (RSVP page, optional)<input class="input" type="url" value={f.url} onInput={set("url")} /></label>
        <label>Description<textarea class="input" rows={4} value={f.description} onInput={set("description")} /></label>
        <button class="btn btn-primary" type="submit">Publish event</button>
      </form>
    </div>
  );
}

/* ─────────────────────────── profile ─────────────────────────── */
function Profile({ handle, me, refresh }: { handle: string; me: any; refresh: () => void }) {
  const [d, setD] = useState<any>(null);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState<any>({});
  const load = useCallback(async () => { const r = await api.profile(handle); setD(r); setForm({ displayName: r.profile?.displayName, bio: r.profile?.bio || "", handle: r.profile?.handle, socialEnabled: r.profile?.socialEnabled }); }, [handle]);
  useEffect(() => { load(); }, [load]);
  if (!d || !d.profile) return <p class="muted">Profile not found.</p>;
  const p = d.profile;
  const isMe = d.isMe;
  return (
    <div class="profile">
      <div class="profile-head">
        <Avatar user={p} size={72} />
        <div>
          <h2>{p.displayName}</h2>
          <div class="muted">@{p.handle} · {d.points} pts</div>
        </div>
      </div>
      {p.bio && <p>{p.bio}</p>}
      {isMe && !edit && (
        <div class="row">
          <button class="btn" onClick={() => setEdit(true)}>Edit profile</button>
          <label class="btn">Change photo<input type="file" accept="image/*" hidden onChange={async (e: any) => { const f = e.target.files[0]; if (f) { await api.uploadAvatar(f); load(); refresh(); } }} /></label>
        </div>
      )}
      {isMe && edit && (
        <form class="hostform" onSubmit={async (e) => { e.preventDefault(); const r = await api.updateMe(form); if (r.error === "handle_taken") { alert("Handle taken"); return; } setEdit(false); refresh(); go(`/u/${form.handle}`); }}>
          <label>Name<input class="input" value={form.displayName} onInput={(e: any) => setForm({ ...form, displayName: e.target.value })} /></label>
          <label>Handle<input class="input" value={form.handle} onInput={(e: any) => setForm({ ...form, handle: e.target.value.toLowerCase() })} /></label>
          <label>Bio<textarea class="input" value={form.bio} onInput={(e: any) => setForm({ ...form, bio: e.target.value })} /></label>
          <label class="check"><input type="checkbox" checked={form.socialEnabled} onChange={(e: any) => setForm({ ...form, socialEnabled: e.target.checked })} /> Social on — appear on the leaderboard, be findable by friends</label>
          <div class="row"><button class="btn btn-primary" type="submit">Save</button><button class="btn" type="button" onClick={() => setEdit(false)}>Cancel</button></div>
        </form>
      )}
      {!isMe && me && d.friendStatus?.status !== "accepted" && (
        d.friendStatus?.status === "pending"
          ? (d.friendStatus.incoming
            ? <button class="btn btn-primary" onClick={async () => { await api.respondFriend(p.id, true); load(); }}>Accept friend request</button>
            : <span class="muted">Friend request sent</span>)
          : <button class="btn btn-primary" onClick={async () => { await api.requestFriend(p.id); load(); }}>Add friend</button>
      )}
      {!isMe && d.friendStatus?.status === "accepted" && <span class="chip on">✓ Friends</span>}
    </div>
  );
}

/* ─────────────────────────── map ─────────────────────────── */
function MapView() {
  const ref = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let map: any;
    (async () => {
      const mod: any = await import("maplibre-gl");
      const maplibre = mod.default ?? mod;
      const r = await api.events("?limit=2000");
      const withCoords = (r.events ?? []).filter((e: any) => e.latitude != null && e.longitude != null);
      setCount(withCoords.length);
      map = new maplibre.Map({
        container: ref.current!,
        // Inline OSM raster style — no external style.json fetch, always renders.
        style: {
          version: 8,
          sources: {
            osm: {
              type: "raster",
              tiles: ["https://a.tile.openstreetmap.org/{z}/{x}/{y}.png", "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png", "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png"],
              tileSize: 256,
              attribution: "© OpenStreetMap contributors",
            },
          },
          layers: [{ id: "osm", type: "raster", source: "osm" }],
        },
        center: [-122.33, 37.66],
        zoom: 8.6,
      });
      map.on("load", () => {
        for (const e of withCoords) {
          const el = document.createElement("div");
          el.className = "map-pin";
          new maplibre.Marker({ element: el }).setLngLat([e.longitude, e.latitude])
            .setPopup(new maplibre.Popup({ offset: 12 }).setHTML(`<b>${e.title}</b><br>${fmtDate(e.startUtc, e.timezone)}`))
            .addTo(map);
        }
      });
    })();
    return () => { if (map) map.remove(); };
  }, []);
  return (
    <div>
      <h2>Event map</h2>
      {count === 0 && <p class="muted">Pins appear as events get geocoded (hosted events + geocoding backfill).</p>}
      <div ref={ref} class="map" />
    </div>
  );
}

/* ─────────────────────────── shell ─────────────────────────── */
function App() {
  const { me, points, refresh } = useAuth();
  const route = useRoute();
  const [, forceNav] = useState(0);

  useEffect(() => {
    // if signed out and on a protected route, bounce to signin
  }, [route, me]);

  if (me === undefined) return <div class="loading">Loading…</div>;

  const parts = route.split("/").filter(Boolean); // e.g. ["event","123"]
  let view;
  if (parts[0] === "event" && parts[1]) view = <EventPage id={parts[1]} me={me} refresh={refresh} />;
  else if (parts[0] === "u" && parts[1]) view = <Profile handle={parts[1]} me={me} refresh={refresh} />;
  else if (parts[0] === "group" && parts[1]) view = me ? <GroupChat id={parts[1]} me={me} /> : <SignIn onDone={refresh} />;
  else if (parts[0] === "friends") view = me ? <Friends /> : <SignIn onDone={refresh} />;
  else if (parts[0] === "groups") view = me ? <Groups /> : <SignIn onDone={refresh} />;
  else if (parts[0] === "leaderboard") view = <Leaderboard me={me} />;
  else if (parts[0] === "host") view = me ? <Host /> : <SignIn onDone={refresh} />;
  else if (parts[0] === "map") view = <MapView />;
  else if (parts[0] === "me") view = me ? <Profile handle={me.handle} me={me} refresh={refresh} /> : <SignIn onDone={refresh} />;
  else if (parts[0] === "signin") view = me ? (go("/"), <Feed me={me} refresh={refresh} />) : <SignIn onDone={refresh} />;
  else view = <Feed me={me} refresh={refresh} />;

  const nav: [string, string][] = [["/", "Events"], ["/map", "Map"], ["/friends", "Friends"], ["/groups", "Groups"], ["/leaderboard", "Leaderboard"], ["/host", "Host"]];

  return (
    <div class="app">
      <header class="topbar">
        <Link href="/" class="brand">📡 The Bay</Link>
        <nav>{nav.map(([h, l]) => <Link href={h} class={"navlink" + (("/" + (parts[0] || "")) === h ? " on" : "")}>{l}</Link>)}</nav>
        <div class="spacer" />
        {me ? (
          <div class="me">
            <span class="pts-chip">✦ {points}</span>
            <Link href="/me"><Avatar user={me} size={30} /></Link>
            <button class="btn tiny" onClick={async () => { await api.logout(); refresh(); go("/"); }}>Sign out</button>
          </div>
        ) : (
          <Link href="/signin" class="btn btn-primary">Sign in</Link>
        )}
      </header>
      {me && me.socialEnabled === false && (
        <div class="nudge">✦ Turn on social to appear on the leaderboard &amp; connect with friends.
          <button class="btn tiny" onClick={async () => { await api.updateMe({ socialEnabled: true }); refresh(); }}>Enable</button>
        </div>
      )}
      <main class="content">{view}</main>
      <a class="back-dash" href="/">← back to the classic dashboard</a>
    </div>
  );
}

render(<App />, document.getElementById("root")!);
