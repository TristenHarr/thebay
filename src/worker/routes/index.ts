import type { Hono } from "hono";
import { authRoutes } from "./auth";
import { socialRoutes } from "./social";
import { platformRoutes } from "./platform";
import { graphRoutes } from "./graph";
import { integrationRoutes } from "./integrations";
import { mediaRoutes } from "./media";
import { aiRoutes } from "./ai";
import { pushRoutes } from "./push";
import { notesRoutes } from "./notes";
import { shadowsRoutes } from "./shadows";
import { searchRoutes } from "./search";
import { vibesRoutes } from "./vibes";
import { placesRoutes } from "./places";
import { mapsRoutes } from "./maps";
import { companiesRoutes } from "./companies";
import { attributionRoutes } from "./attribution";
import { xpRoutes } from "./xp";
import { movementRoutes } from "./movement";
import { orbsRoutes } from "./orbs";
import { catchesRoutes } from "./catches";
import { crawlsRoutes } from "./crawls";
import { networkRoutes } from "./network";
import { rankRoutes } from "./rank";
import { trophyRoutes } from "./trophies";
import { gymRoutes } from "./gym";
import { identityRoutes } from "./identity";
// gen:imports (do not remove) — `npm run new:feature` inserts new route imports above this line

/**
 * THE single source of truth for API route modules.
 *
 * Adding a feature = add its factory to this array (the generator does it for
 * you). It is then automatically (a) mounted in the Worker (src/worker/index.ts)
 * and (b) covered by the HTTP integration-test harness (tests/helpers/app.ts).
 * There is no second place to wire a route — that's the pit of success.
 */
// Loose by design: route modules declare their own Variables (some use none),
// and `app.route()` accepts any Hono instance, so we don't over-constrain here.
export type RouteFactory = () => Hono<any>;

export const routeFactories: RouteFactory[] = [
  authRoutes,
  socialRoutes,
  platformRoutes,
  graphRoutes,
  integrationRoutes,
  mediaRoutes,
  aiRoutes,
  pushRoutes,
  notesRoutes,
  shadowsRoutes,
  // Pre-registered by M0 so five parallel tracks never contend for this file.
  // Each factory starts empty; its track fills it in.
  searchRoutes, // Track A — hybrid search
  vibesRoutes, // Track B — event vibes
  placesRoutes, // Track C — crowd city map
  mapsRoutes, // Track D — offline packs + walking nav
  companiesRoutes, // Track E — companies + funding rounds
  attributionRoutes, // Track E — outcomes + attribution
  xpRoutes, // Experience / leveling (Trails game)
  movementRoutes, // Mobbing — live movement → XP + trails + tracker
  orbsRoutes, // Floating XP orbs — deterministic spawn + proximity pickup
  catchesRoutes, // Catches — the founder Pokédex (catch people via QR)
  crawlsRoutes, // Founder crawls — planned, shareable routes you mob together
  networkRoutes, // The scrape network — in-person membership, clients, jobs
  rankRoutes, // The learning loop — impressions, feedback, the live model
  trophyRoutes, // The trophy catalog — declarative trophies, granted on read
  gymRoutes, // Gyms — hosts award XP, capped by verified dwell time
  identityRoutes, // Founder types, vouches, cards + host-minted badges
  // gen:registry (do not remove) — `npm run new:feature` inserts new factories above this line
];
