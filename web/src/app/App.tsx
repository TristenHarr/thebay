import { lazy, Suspense, type ReactNode } from "react";
import { NavLink, Route, Routes, Link, useLocation } from "react-router-dom";
import { useGetMeQuery, useLogoutMutation } from "../api";
import { useState } from "react";
import { Avatar, Button, cx } from "../ui/kit";
import { getTheme, toggleTheme } from "../theme";
import { Placeholder } from "../ui/Placeholder";
import { CommandPalette } from "../ui/CommandPalette";
import { SignIn } from "../features/auth/SignIn";

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
// MapView pulls in MapLibre (~800kB) — lazy-load it so it never touches the main bundle.
const MapView = lazy(() => import("../features/map/MapView").then((m) => ({ default: m.MapView })));
const Board = lazy(() => import("../features/board/Board").then((m) => ({ default: m.Board })));
// The live board floats over every page (never menu-hidden). Lazy so MapLibre only
// loads when someone actually opens it.
const FloatingBoard = lazy(() => import("../features/board/FloatingBoard").then((m) => ({ default: m.FloatingBoard })));

const PRIMARY: [string, string][] = [
  ["/", "Home"],
  ["/discover", "Discover"],
  ["/goals", "Goals"],
  ["/network", "Network"],
  ["/me", "Me"],
];

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

function NetworkHub() {
  const links: [string, string][] = [
    ["/friends", "Friends"], ["/groups", "Groups"], ["/intros", "Intros"], ["/mentors", "Mentors"],
    ["/match", "Match"], ["/communities", "Communities"], ["/network-graph", "Graph"], ["/leaderboard", "Rankings"], ["/agent", "AI Agent"],
  ];
  return (
    <div data-testid="network-hub">
      <h1 className="mb-4 text-2xl font-bold tracking-tight">Network</h1>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {links.map(([to, label]) => (
          <Link key={to} to={to} className="rounded-lg border border-border bg-elev p-4 font-semibold hover:border-accent">{label}</Link>
        ))}
      </div>
    </div>
  );
}

export function App() {
  const { data, isLoading } = useGetMeQuery();
  const me = data?.user ?? null;
  const [logout] = useLogoutMutation();
  useLocation();

  if (isLoading) return <div className="p-16 text-center text-muted">Loading…</div>;

  return (
    <div className="min-h-full">
      <CommandPalette />
      <header className="sticky top-0 z-20 flex items-center gap-4 border-b border-border bg-bg/85 px-4 py-2.5 backdrop-blur">
        <Link to="/" className="font-mono text-sm font-bold">📡 the.bay</Link>
        <nav className="hidden gap-1 sm:flex">
          {PRIMARY.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => cx("rounded-full px-3 py-1.5 text-sm font-semibold", isActive ? "bg-accent text-accent-ink" : "text-muted hover:text-text")}>
              {label}
            </NavLink>
          ))}
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

      <main className="mx-auto max-w-3xl px-4 py-6 pb-24">
        <Routes>
          <Route path="/" element={<Discover me={me} />} />
          <Route path="/discover" element={<Discover me={me} />} />
          <Route path="/map" element={<Suspense fallback={<div className="p-16 text-center text-muted">Loading map…</div>}><MapView /></Suspense>} />
          <Route path="/board" element={<Suspense fallback={<div className="p-16 text-center text-muted">Loading board…</div>}><Board me={me} /></Suspense>} />
          <Route path="/event/:id" element={<EventPage me={me} />} />
          <Route path="/event/:id/review" element={<Guard me={me}><ReviewPage /></Guard>} />
          <Route path="/event/:id/checkin" element={<Guard me={me}><Checkin me={me} /></Guard>} />
          <Route path="/goals" element={<Guard me={me}><Goals /></Guard>} />
          <Route path="/achievements" element={<Guard me={me}><Achievements /></Guard>} />
          <Route path="/me" element={<Guard me={me}><Profile self /></Guard>} />
          <Route path="/u/:handle" element={<Profile />} />
          <Route path="/network" element={<Guard me={me}><NetworkHub /></Guard>} />
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
          <Route path="/signin" element={<SignIn />} />
          <Route path="*" element={<Discover me={me} />} />
        </Routes>
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-20 flex justify-around border-t border-border bg-bg/95 py-2 backdrop-blur sm:hidden">
        {PRIMARY.map(([to, label]) => (
          <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => cx("px-3 py-1 text-xs font-semibold", isActive ? "text-accent" : "text-muted")}>
            {label}
          </NavLink>
        ))}
      </nav>

      {/* The live, ephemeral board — floats over the whole app, pinnable + draggable. */}
      <Suspense fallback={null}>
        <FloatingBoard me={me} />
      </Suspense>
    </div>
  );
}
