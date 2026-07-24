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
  // gen:registry (do not remove) — `npm run new:feature` inserts new factories above this line
];
