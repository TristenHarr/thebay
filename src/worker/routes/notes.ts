import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { NotesRepo } from "../../storage/d1/notes-repo";
import { requireAuth, optionalAuth } from "../../auth/middleware";
import { inBay } from "../../core/geo";

type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;
const repo = (c: { env: Env }) => new NotesRepo(c.env.DB);
const MAX_LEN = 280;

export function notesRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  // Read the board (open to everyone).
  app.get("/api/notes", optionalAuth, async (c) => c.json({ notes: await repo(c).recent() }));

  // Post a note — must be physically in the Bay Area (GPS gate) + signed in.
  app.post("/api/notes", requireAuth, async (c) => {
    const { lat, lng, body } = (await c.req.json().catch(() => ({}))) as { lat?: number; lng?: number; body?: string };
    const text = (body ?? "").trim();
    if (!text) return c.json({ error: "note can't be empty" }, 400);
    if (text.length > MAX_LEN) return c.json({ error: `note too long (max ${MAX_LEN})` }, 400);
    if (typeof lat !== "number" || typeof lng !== "number" || !inBay(lat, lng)) {
      return c.json({ error: "you must be in the Bay Area to post to the board" }, 403);
    }
    return c.json({ ok: true, id: await repo(c).post(c.get("user")!.id, lat, lng, text) });
  });

  return app;
}
