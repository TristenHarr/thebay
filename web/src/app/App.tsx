import { lazy, Suspense, type ReactNode } from "react";
import { NavLink, Route, Routes, Link, Navigate, useLocation } from "react-router-dom";
import { useDispatch } from "react-redux";
import { useGetMeQuery, useLogoutMutation } from "../api";
import { useState, useEffect } from "react";
import { setMode } from "../features/board/shadowsSlice";
import { Avatar, Button, cx } from "../ui/kit";
import { getTheme, toggleTheme } from "../theme";
import { Placeholder } from "../ui/Placeholder";
import { CommandPalette } from "../ui/CommandPalette";
import { SignIn } from "../features/auth/SignIn";
import { SECTIONS, sectionFor } from "./nav";
import { SectionTabs } from "./SectionTabs";

/** The sibling site. Sign-in is shared, so links go via the handoff endpoint. */
export const NEWS_ORIGIN = "https://thebay.news";
import { Discover } from "../features/discover/Discover";
import { EventPage, ReviewPage } from "../features/events/EventPage";
import { Goals } from "../features/goals/Goals";
import { Profile } from "../features/profile/Profile";
import { Friends } from "../features/friends/Friends";
import { Groups, GroupChat } from "../features/groups/Groups";
import { Leaderboard } from "../features/leaderboard/Leaderboard";
import { Host } from "../features/host/Host";
import { Intros } from "../features/intros/Intros";
import { Mentors } from "../features/mentors/Mentors";
import { Match } from "../features/match/Match";
import { Communities } from "../features/communities/Communities";
import { Community } from "../features/communities/Community";
import { NetworkGraph } from "../features/graph/NetworkGraph";
import { Achievements } from "../features/achievements/Achievements";
import { Checkin } from "../features/checkin/Checkin";
import { Media } from "../features/media/Media";
import { Itinerary } from "../features/itinerary/Itinerary";
import { Integrations } from "../features/integrations/Integrations";
import { Agent } from "../features/agent/Agent";
import { VibePage } from "../features/vibe/VibePage"; // track:B
import { Companies } from "../features/companies/Companies"; // track:E
import { Company } from "../features/companies/Company"; // track:E
import { Impact } from "../features/impact/Impact"; // track:E
// MapView pulls in MapLibre (~800kB) — lazy-load it so it never touches the main bundle.
const MapView = lazy(() => import("../features/map/MapView").then((m) => ({ default: m.MapView })));
// track:C — the crowd city map (MapLibre again, so lazy for the same reason).
const City = lazy(() => import("../features/city/City").then((m) => ({ default: m.City })));
// track:D — offline vector basemap + on-device walking navigation. Lazy for the
// MapLibre reason AND because it pulls in the routing worker + PMTiles reader.
const Nav = lazy(() => import("../features/nav/Nav").then((m) => ({ default: m.Nav })));
// The live board floats over every page (never menu-hidden). Lazy so MapLibre only
// loads when someone actually opens it. It supersedes the old /board page.
const FloatingBoard = lazy(() => import("../features/board/FloatingBoard").then((m) => ({ default: m.FloatingBoard })));

/** The old /board page is retired — the board now floats over the whole app. Any
 *  /board link (menus, command palette, deep links) opens the floating board and
 *  lands on home. */
function BoardRedirect() {
  const dispatch = useDispatch();
  useEffect(() => { dispatch(setMode("open")); }, [dispatch]);
  return <Navigate to="/" replace />;
}

const Guard = ({ me, children }: { me: any; children: ReactNode }) => (me ? <>{children}</> : <SignIn />);

function ThemeToggle() {
  const [theme, setTheme] = useState(getTheme());
  return (
    <button
      onClick={() => setTheme(toggleTheme())}
      className="rounded-lg border border-border px-2 py-1 text-sm text-muted hover:border-accent hover:text-text"
      aria-label="Toggle light/dark theme"
      title="Toggle theme"
    >
      {theme === "dark" ? "☀︎" : "☾"}
    </button>
  );
}

/** Section links — the top level. Rendered in the desktop header and, with the
 *  same active logic, in the mobile bottom bar. `sectionFor` (not NavLink's own
 *  matching) decides what's active, so `/event/:id` still lights up Discover. */
function SectionLinks({ pathname, variant }: { pathname: string; variant: "header" | "bar" }) {
  const active = sectionFor(pathname)?.id;
  return (
    <>
      {SECTIONS.map((s) => {
        const on = s.id === active;
        return (
          <Link
            key={s.id}
            to={s.to}
            data-testid={`section-${s.id}`}
            className={
              variant === "header"
                ? cx("rounded-full px-3 py-1.5 text-sm font-semibold", on ? "bg-accent text-accent-ink" : "text-muted hover:text-text")
                : cx("px-3 py-1 text-xs font-semibold", on ? "text-accent" : "text-muted")
            }
          >
            {s.label}
          </Link>
        );
      })}
    </>
  );
}

export function App() {
  const { data, isLoading } = useGetMeQuery();
  const me = data?.user ?? null;
  const [logout] = useLogoutMutation();
  const { pathname } = useLocation();

  if (isLoading) return <div className="p-16 text-center text-muted">Loading…</div>;

  return (
    <div className="min-h-full">
      <CommandPalette />
      <header className="sticky top-0 z-20 flex items-center gap-4 border-b border-border bg-bg/85 px-4 py-2.5 backdrop-blur">
        <Link to="/" className="font-mono text-sm font-bold">📡 the.bay</Link>
        <nav className="hidden gap-1 sm:flex" aria-label="Sections">
          <SectionLinks pathname={pathname} variant="header" />
        </nav>
        <div className="flex-1" />
        {/* Cross-site switcher — the mirror of the one on thebay.news.
            The handoff starts on the origin you're LEAVING (relative path here),
            which mints for the sibling and redirects there. Pointing this at
            thebay.news/auth/handoff/start would bounce you straight back. */}
        <a
          href={`/auth/handoff/start?next=%2F&theme=${getTheme()}`}
          className="hidden items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted hover:border-accent hover:text-accent sm:flex"
          title="thebay.news — Bay Area tech news"
        >
          <span className="font-mono">≈ news</span>
        </a>
        <button
          onClick={() => window.dispatchEvent(new Event("open-command-palette"))}
          className="hidden items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs text-muted hover:border-accent hover:text-text sm:flex"
          aria-label="Open command palette"
        >
          <span>Jump to</span><kbd className="rounded bg-surface px-1 font-mono text-[10px]">⌘K</kbd>
        </button>
        <ThemeToggle />
        {me ? (
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-gold">✦ {data?.points ?? 0}</span>
            <Link to="/me"><Avatar user={me} size={30} /></Link>
            <Button variant="quiet" className="text-xs" onClick={() => logout()}>Sign out</Button>
          </div>
        ) : (
          <Link to="/signin"><Button>Sign in</Button></Link>
        )}
      </header>

      <SectionTabs signedIn={!!me} />

      <main className="mx-auto max-w-3xl px-4 py-6 pb-24">
        <Routes>
          <Route path="/" element={<Discover me={me} />} />
          <Route path="/discover" element={<Discover me={me} />} />
          <Route path="/map" element={<Suspense fallback={<div className="p-16 text-center text-muted">Loading map…</div>}><MapView /></Suspense>} />
          <Route path="/board" element={<BoardRedirect />} />
          <Route path="/event/:id" element={<EventPage me={me} />} />
          <Route path="/event/:id/review" element={<Guard me={me}><ReviewPage /></Guard>} />
          <Route path="/event/:id/checkin" element={<Guard me={me}><Checkin me={me} /></Guard>} />
          <Route path="/goals" element={<Guard me={me}><Goals /></Guard>} />
          <Route path="/achievements" element={<Guard me={me}><Achievements /></Guard>} />
          <Route path="/me" element={<Guard me={me}><Profile self /></Guard>} />
          <Route path="/u/:handle" element={<Profile />} />
          {/* The old hub URLs. `/network` was a card grid and `/people`+`/signal`
              are the section ids — all three land on the section's first tab, so
              existing links, bookmarks and the sitemap keep working. */}
          <Route path="/network" element={<Navigate to="/friends" replace />} />
          <Route path="/people" element={<Navigate to="/friends" replace />} />
          <Route path="/signal" element={<Navigate to="/impact" replace />} />
          <Route path="/friends" element={<Guard me={me}><Friends /></Guard>} />
          <Route path="/groups" element={<Guard me={me}><Groups /></Guard>} />
          <Route path="/group/:id" element={<Guard me={me}><GroupChat me={me} /></Guard>} />
          <Route path="/intros" element={<Guard me={me}><Intros /></Guard>} />
          <Route path="/mentors" element={<Guard me={me}><Mentors /></Guard>} />
          <Route path="/match" element={<Guard me={me}><Match /></Guard>} />
          <Route path="/communities" element={<Guard me={me}><Communities /></Guard>} />
          <Route path="/community/:id" element={<Guard me={me}><Community /></Guard>} />
          <Route path="/network-graph" element={<Guard me={me}><NetworkGraph /></Guard>} />
          <Route path="/leaderboard" element={<Leaderboard me={me} />} />
          <Route path="/media" element={<Guard me={me}><Media /></Guard>} />
          <Route path="/itinerary" element={<Guard me={me}><Itinerary /></Guard>} />
          <Route path="/integrations" element={<Guard me={me}><Integrations /></Guard>} />
          <Route path="/host" element={<Guard me={me}><Host /></Guard>} />
          <Route path="/agent" element={<Guard me={me}><Agent /></Guard>} />
          {/* Parallel-track regions — each track adds its <Route>s inside its own
              block so five agents never contend for the same lines here. Every new
              screen also needs a data-testid + a tests/nav-matrix.mjs row. */}
          {/* track:A */}
          {/* track:B */}
          <Route path="/event/:id/vibe" element={<VibePage me={me} />} />
          {/* end track:B */}
          {/* track:C */}
          <Route path="/city" element={<Suspense fallback={<div className="p-16 text-center text-muted">Loading the city…</div>}><City me={me} /></Suspense>} />
          {/* end track:C */}
          {/* track:D */}
          <Route path="/nav" element={<Suspense fallback={<div className="p-16 text-center text-muted">Loading the walk router…</div>}><Nav /></Suspense>} />
          {/* end track:D */}
          {/* track:E */}
          <Route path="/companies" element={<Companies me={me} />} />
          <Route path="/company/:slug" element={<Company me={me} />} />
          <Route path="/impact" element={<Impact me={me} />} />
          {/* end track:E */}
          <Route path="/signin" element={<SignIn />} />
          <Route path="*" element={<Discover me={me} />} />
        </Routes>
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-20 flex justify-around border-t border-border bg-bg/95 py-2 backdrop-blur sm:hidden" aria-label="Sections">
        <SectionLinks pathname={pathname} variant="bar" />
      </nav>

      {/* The live, ephemeral board — floats over the whole app, pinnable + draggable. */}
      <Suspense fallback={null}>
        <FloatingBoard me={me} />
      </Suspense>
    </div>
  );
}
