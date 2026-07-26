/**
 * THE single source of truth for navigation.
 *
 * The app grew to ~25 screens behind 5 nav slots, and everything that didn't fit
 * got dumped into a `/network` grid of undifferentiated cards. That grid was the
 * problem: it turned "see who's going" into two clicks through a menu that told
 * you nothing, and it silently became the place features went to be forgotten.
 *
 * So: five sections that match what someone actually came here to do, each with a
 * flat tab strip. Two shallow levels, no hubs, nothing hidden. Every screen has
 * exactly one home, and this file is the only place that decides where.
 *
 * Everything downstream derives from `SECTIONS` — the desktop header, the mobile
 * bar, the tab strips, and the command palette. They cannot drift apart, because
 * there is nothing to keep in sync.
 */
export interface NavItem {
  to: string;
  label: string;
  /** Signed-in only. Guarded routes still render a sign-in prompt if visited. */
  auth?: boolean;
  /** Longer description, used by the command palette only. */
  hint?: string;
  /**
   * Extra path prefixes this tab stays highlighted for. Needed because several
   * detail routes are the SINGULAR of their list route — `/group/:id` under
   * Groups, `/community/:id` under Communities, `/company/:slug` under Companies.
   * Without this the strip renders with nothing active on those pages, which
   * reads as the app having lost your place.
   */
  owns?: string[];
}

export interface NavSection {
  id: string;
  label: string;
  /** Where the section link itself points — always its first public screen. */
  to: string;
  items: NavItem[];
  /**
   * Path prefixes this section owns, including detail routes that never appear
   * as tabs (`/event/:id`, `/company/:slug`). Used to light up the right section
   * and tab strip for any URL. Longest match wins, so `/network-graph` beating
   * `/network` is decided by length, not by order.
   */
  owns: string[];
}

export const SECTIONS: NavSection[] = [
  {
    id: "discover",
    label: "Discover",
    to: "/discover",
    owns: ["/", "/discover", "/event", "/map", "/itinerary", "/host", "/gyms"],
    items: [
      { to: "/discover", label: "Feed", hint: "Search and browse every Bay event" },
      { to: "/map", label: "Map", hint: "Events on a map" },
      { to: "/itinerary", label: "Itinerary", auth: true, hint: "What you've RSVP'd to" },
      { to: "/host", label: "Host", auth: true, hint: "Post your own event" },
      // Sits next to Host because it is the other half of the same job: you post an
      // event, then you run its gym.
      { to: "/gyms", label: "Gyms", auth: true, hint: "Run your events as gyms — award XP to who showed up" },
    ],
  },
  {
    id: "city",
    label: "City",
    to: "/city",
    owns: ["/city", "/nav", "/board", "/crawls"],
    items: [
      { to: "/city", label: "Places", hint: "Parking, wifi and crowd-sourced spots" },
      { to: "/nav", label: "Walk", hint: "Offline map and walking directions" },
      // A crawl is a route through the city with checkpoints, so it lives beside Walk.
      { to: "/crawls", label: "Crawls", auth: true, hint: "Multi-venue routes with checkpoints" },
    ],
  },
  {
    id: "people",
    label: "People",
    to: "/friends",
    owns: ["/people", "/network", "/friends", "/groups", "/group", "/intros", "/mentors", "/match", "/communities", "/community", "/u", "/handshake", "/pokedex"],
    items: [
      { to: "/friends", label: "Friends", auth: true, hint: "Your connections", owns: ["/friends", "/u"] },
      // First-class, because meeting somebody in person is the one thing this app is for —
      // and it is also the only door into the scrape network.
      { to: "/handshake", label: "Handshake", auth: true, hint: "Connect in person — show a moving code, or scan theirs" },
      // The collection of people you've met in person, so it belongs beside Handshake.
      { to: "/pokedex", label: "Pokédex", auth: true, hint: "Founders you've caught, and their stat cards" },
      { to: "/groups", label: "Groups", auth: true, hint: "Group chat", owns: ["/groups", "/group"] },
      { to: "/intros", label: "Intros", auth: true, hint: "Warm intros" },
      { to: "/mentors", label: "Mentors", auth: true, hint: "Find or offer mentorship" },
      { to: "/match", label: "Match", auth: true, hint: "Co-founder matching" },
      { to: "/communities", label: "Communities", auth: true, hint: "Groups you belong to", owns: ["/communities", "/community"] },
    ],
  },
  {
    id: "signal",
    label: "Signal",
    to: "/impact",
    owns: ["/signal", "/impact", "/companies", "/company", "/leaderboard", "/network-graph", "/graph-map"],
    items: [
      { to: "/impact", label: "Impact", hint: "Which intros and events led somewhere" },
      { to: "/companies", label: "Companies", hint: "Companies and funding rounds", owns: ["/companies", "/company"] },
      { to: "/leaderboard", label: "Rankings", hint: "Leaderboards" },
      { to: "/network-graph", label: "Graph", auth: true, hint: "Your network, drawn" },
      // The same projection, anchored to real venues instead of laid out abstractly.
      { to: "/graph-map", label: "Map", auth: true, hint: "Your network drawn over the real Bay" },
    ],
  },
  {
    id: "me",
    label: "Me",
    to: "/me",
    owns: ["/me", "/goals", "/achievements", "/media", "/integrations", "/agent", "/contribute", "/identity"],
    items: [
      { to: "/me", label: "Profile", auth: true },
      { to: "/goals", label: "Goals", auth: true, hint: "What you're here to do" },
      { to: "/achievements", label: "Achievements", auth: true },
      // What you are + your card. Next to Achievements because both answer "what does my
      // record look like to somebody else".
      { to: "/identity", label: "Card", auth: true, hint: "Your founder type and stat card" },
      { to: "/media", label: "Moments", auth: true, hint: "Your photos and video" },
      { to: "/integrations", label: "Integrations", auth: true, hint: "Luma, Eventbrite, calendar, LinkedIn" },
      { to: "/agent", label: "Agent", auth: true, hint: "AI networking agent settings" },
      { to: "/contribute", label: "Contribute", auth: true, hint: "Run a scraper for the catalog and see your standing" },
    ],
  },
];

/** True when `pathname` is at or below `prefix`, treating "/" as exact-only. */
function covers(prefix: string, pathname: string): boolean {
  if (prefix === "/") return pathname === "/";
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

/**
 * The section owning `pathname`, by longest matching prefix. Longest-match is what
 * lets `/network-graph` (Signal) and `/network` (People) coexist without the
 * answer depending on array order.
 */
export function sectionFor(pathname: string): NavSection | null {
  let best: NavSection | null = null;
  let bestLen = -1;
  for (const s of SECTIONS) {
    for (const p of s.owns) {
      if (covers(p, pathname) && p.length > bestLen) {
        best = s;
        bestLen = p.length;
      }
    }
  }
  return best;
}

/** The tab whose route is currently showing — again longest-match, so `/group/x`
 *  highlights Groups and `/company/x` highlights Companies. */
export function activeItem(section: NavSection, pathname: string): NavItem | null {
  let best: NavItem | null = null;
  let bestLen = -1;
  for (const it of section.items) {
    for (const p of it.owns ?? [it.to]) {
      if (covers(p, pathname) && p.length > bestLen) {
        best = it;
        bestLen = p.length;
      }
    }
  }
  return best;
}

/** Tabs to show. Signed-out visitors don't see doors that only lead to a prompt. */
export function visibleItems(section: NavSection, signedIn: boolean): NavItem[] {
  return section.items.filter((i) => signedIn || !i.auth);
}

/** Flat list for the command palette, so it can never fall behind the nav. */
export function allDestinations(): Array<NavItem & { section: string }> {
  return SECTIONS.flatMap((s) => s.items.map((i) => ({ ...i, section: s.label })));
}
