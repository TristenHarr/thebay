import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app";
import { createRepository, type Repository } from "../storage";
import { env } from "../config/env";
import { logger } from "../util/logger";

export interface ServerHandle {
  close(): void;
}

export async function startServer(
  opts: { repo?: Repository; port?: number } = {},
): Promise<ServerHandle> {
  const repo = opts.repo ?? createRepository();
  const app = createApp(repo);

  const STATIC_ROOT = "./src/server/public";
  app.get("/", serveStatic({ path: `${STATIC_ROOT}/index.html` }));
  // Embeddable widget (iframe-friendly — no X-Frame-Options set).
  app.get("/embed", serveStatic({ path: `${STATIC_ROOT}/embed.html` }));
  app.use("/*", serveStatic({ root: STATIC_ROOT }));

  const port = opts.port ?? env.PORT;
  const server = serve({ fetch: app.fetch, port }, (info) =>
    logger.info(
      { url: `http://localhost:${info.port}` },
      "eventers dashboard listening",
    ),
  );

  return { close: () => server.close() };
}
