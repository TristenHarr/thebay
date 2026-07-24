import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useGetMeQuery, useGetProfileQuery, useUpdateMeMutation, useRequestFriendMutation, useRespondFriendMutation, useGetPublicGoalsQuery, useGetPublicAchievementsQuery, useCreateIntroMutation, useGetPersonReviewsQuery, useReviewPersonMutation } from "../../api";
import { Avatar, Button, Card, Spinner, input } from "../../ui/kit";
import { usePwaInstall } from "../../pwa";

const TROPHY: Record<string, string> = { first_review: "⭐", first_checkin: "📍", first_host: "🎤", super_connector: "🌟" };

export function Profile({ self }: { self?: boolean }) {
  const params = useParams();
  const { data: meData, refetch: refetchMe } = useGetMeQuery();
  const me = meData?.user;
  const handle = self ? me?.handle : params.handle;
  const { data, refetch } = useGetProfileQuery(handle!, { skip: !handle });
  const { data: pubGoals } = useGetPublicGoalsQuery(handle!, { skip: !handle });
  const { data: pubAch } = useGetPublicAchievementsQuery(handle!, { skip: !handle });
  const { data: personReviews } = useGetPersonReviewsQuery(handle!, { skip: !handle });
  const [reviewPerson] = useReviewPersonMutation();
  const [rvRole, setRvRole] = useState("host");
  const [rvStars, setRvStars] = useState(5);
  const [rvDone, setRvDone] = useState(false);
  const [updateMe] = useUpdateMeMutation();
  const [reqFriend] = useRequestFriendMutation();
  const [respondFriend] = useRespondFriendMutation();
  const [createIntro] = useCreateIntroMutation();
  const [introAsked, setIntroAsked] = useState(false);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState<any>({});
  const pwa = usePwaInstall();

  if (!handle) return <Spinner />;
  if (!data) return <Spinner />;
  if (!data.profile) return <p className="text-muted">Profile not found.</p>;
  const p = data.profile;

  async function uploadAvatar(file: File) {
    await fetch("/api/me/avatar", { method: "POST", headers: { "content-type": file.type }, body: file, credentials: "same-origin" });
    refetch(); refetchMe();
  }

  return (
    <div data-testid="profile">
      <div className="flex items-center gap-4">
        <Avatar user={p} size={72} />
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">{p.displayName}</h1>
          <div className="font-mono text-sm text-muted">@{p.handle} · <span className="text-gold">{data.points ?? 0} pts</span></div>
        </div>
      </div>
      {p.bio && <p className="mt-3 text-muted">{p.bio}</p>}

      {data.isMe && (
        <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-6">
          {([["/itinerary", "🗓", "Itinerary"], ["/media", "📸", "Moments"], ["/achievements", "🏆", "Trophies"], ["/goals", "🎯", "Goals"], ["/host", "🎤", "Host"], ["/integrations", "🔌", "Connect"]] as [string, string, string][]).map(([to, icon, label]) => (
            <Link key={to} to={to} className="flex flex-col items-center gap-1 rounded-lg border border-border bg-elev p-3 text-xs font-semibold hover:border-accent">
              <span className="text-xl">{icon}</span>{label}
            </Link>
          ))}
        </div>
      )}

      {data.isMe && !pwa.installed && (pwa.canInstall || pwa.isIos) && (
        <Card className="mt-4 flex items-center justify-between gap-2 border-accent/40 bg-accent/5 p-3 text-sm">
          <span>📲 Install The Bay as an app{pwa.isIos ? " — tap Share, then “Add to Home Screen”." : "."}</span>
          {pwa.canInstall && <Button onClick={() => pwa.install()}>Install</Button>}
        </Card>
      )}

      {data.isMe && !edit && (
        <div className="mt-4 flex gap-2">
          <Button variant="ghost" onClick={() => { setEdit(true); setForm({ displayName: p.displayName, handle: p.handle, bio: p.bio || "", socialEnabled: p.socialEnabled }); }}>Edit profile</Button>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-border bg-surface px-4 py-2 text-sm font-semibold text-muted hover:border-accent hover:text-text">
            Change photo
            <input type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && uploadAvatar(e.target.files[0])} />
          </label>
        </div>
      )}
      {data.isMe && edit && (
        <Card className="mt-4 flex flex-col gap-2 p-4">
          <input className={input} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="Name" />
          <input className={input} value={form.handle} onChange={(e) => setForm({ ...form, handle: e.target.value.toLowerCase() })} placeholder="handle" />
          <textarea className={input} value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} placeholder="Bio" />
          <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={!!form.socialEnabled} onChange={(e) => setForm({ ...form, socialEnabled: e.target.checked })} /> Social on — appear on the leaderboard & be findable</label>
          <div className="flex gap-2">
            <Button onClick={async () => { const r: any = await updateMe(form); if (r.data?.error === "handle_taken") { alert("Handle taken"); return; } setEdit(false); refetch(); }}>Save</Button>
            <Button variant="quiet" onClick={() => setEdit(false)}>Cancel</Button>
          </div>
        </Card>
      )}

      {/* public goals — shared with the world */}
      {(pubGoals?.goals?.length ?? 0) > 0 && (
        <div className="mt-6">
          <h3 className="mb-2 text-sm font-semibold text-muted">Goals</h3>
          <div className="flex flex-col gap-2">
            {pubGoals!.goals.map((g: any) => (
              <Card key={g.id} className="flex items-center gap-3 p-3">
                <span className={g.status === "done" ? "text-muted line-through" : ""}>{g.title}</span>
                {g.status === "done" && <span className="ml-auto text-xs text-ok">✓ done</span>}
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* trophy case — public achievements */}
      {(pubAch?.achievements?.length ?? 0) > 0 && (
        <div className="mt-6">
          <h3 className="mb-2 text-sm font-semibold text-muted">Trophies</h3>
          <div className="flex flex-wrap gap-2">
            {pubAch!.achievements.map((a: any, i: number) => (
              <span key={i} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-elev px-3 py-1.5 text-sm">
                <span>{TROPHY[a.kind] || "🏅"}</span> {a.kind.replace(/_/g, " ")}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* reputation — reviews received as host / speaker / participant */}
      {((personReviews?.rating?.count ?? 0) > 0 || (!data.isMe && me)) && (
        <div className="mt-6">
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-sm font-semibold text-muted">Reviews</h3>
            {personReviews?.rating?.avg != null && <span className="text-sm text-gold">★ {personReviews.rating.avg} <span className="text-muted">({personReviews.rating.count})</span></span>}
            {personReviews && Object.entries(personReviews.rating.byRole).map(([role, r]) => (
              <span key={role} className="rounded-full bg-surface px-2 py-0.5 text-[10px] text-muted">{role}: ★{r.avg}</span>
            ))}
          </div>
          {!data.isMe && me && (
            rvDone ? <span className="text-xs text-ok">✓ Review submitted</span> : (
              <Card className="mb-2 flex flex-wrap items-center gap-2 p-3 text-sm">
                <span className="text-muted">Rate as</span>
                {["host", "speaker", "participant"].map((r) => (
                  <button key={r} onClick={() => setRvRole(r)} className={`rounded-full px-2 py-0.5 text-xs ${rvRole === r ? "bg-accent text-accent-ink" : "border border-border text-muted"}`}>{r}</button>
                ))}
                <span className="ml-2">{[1, 2, 3, 4, 5].map((n) => <button key={n} onClick={() => setRvStars(n)} className={n <= rvStars ? "text-gold" : "text-border"}>★</button>)}</span>
                <Button variant="ghost" onClick={async () => { await reviewPerson({ userId: p.id, subjectType: rvRole, rating: rvStars }); setRvDone(true); }}>Submit</Button>
              </Card>
            )
          )}
          <div className="flex flex-col gap-1.5">
            {(personReviews?.reviews || []).slice(0, 5).map((r: any, i: number) => (
              <div key={i} className="text-sm"><span className="text-gold">{"★".repeat(r.rating)}</span> <span className="text-muted">{r.author} · {r.subjectType}</span>{r.body && <span> — {r.body}</span>}</div>
            ))}
          </div>
        </div>
      )}

      {!data.isMe && me && (
        <div className="mt-6 flex flex-wrap items-center gap-2">
          {data.friendStatus?.status === "accepted" ? (
            <span className="rounded-full bg-ok/15 px-3 py-1 text-sm text-ok">✓ Friends</span>
          ) : data.friendStatus?.status === "pending" ? (
            data.friendStatus.incoming ? (
              <Button onClick={async () => { await respondFriend({ uid: p.id, accept: true }); refetch(); }}>Accept friend request</Button>
            ) : <span className="text-sm text-muted">Request sent</span>
          ) : (
            <Button onClick={async () => { await reqFriend(p.id); refetch(); }}>Add friend</Button>
          )}
          {/* warm intro through a mutual — routes to friends-of-friends who can forward */}
          {data.friendStatus?.status !== "accepted" && (
            introAsked
              ? <span className="text-sm text-muted">🤝 Intro requested</span>
              : <Button variant="ghost" onClick={async () => { await createIntro({ targetDesc: p.displayName, targetUserId: p.id }); setIntroAsked(true); }}>Request a warm intro</Button>
          )}
        </div>
      )}
    </div>
  );
}
