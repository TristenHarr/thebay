import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { ShadowsRepo } from "../../storage/d1/shadows-repo";
import { SocialRepo } from "../../storage/d1/social-repo";
import { requireAuth, optionalAuth } from "../../auth/middleware";
import { inBay } from "../../core/geo";
import { ShadowPostSchema, ShadowReactSchema } from "../../../shared/schema";
import { screenText, moderateText } from "../../ai/moderation";
import { ulid } from "ulid";

/**
 * Shadows — the ephemeral, location-sharded live board (see migrations/0011,
 * src/storage/d1/shadows-repo, src/core/geohash). Reads are cheap and public:
 * a bounded set of fine cells for a zoomed-in viewport, or a coarse edge-cached
 * heat aggregate for the whole-Bay view. Writes are signed-in, Bay-GPS-gated, and
 * 1-per-account (a new shadow replaces your old). Realtime fan-out to the per-cell
 * Durable Object + AI moderation are layered on in later stages; this is the
 * durable HTTP surface they build on.
 */
type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;
const repo = (c: { env: Env }) => new ShadowsRepo(c.env.DB);

const MAX_CELLS = 64; // bounds the zoomed-in fan-out (one query/WS per visible cell)
const HEAT_MIN_P = 1;
const HEAT_MAX_P = 7;
const CELL_RE = /^[0-9bcdefghjkmnpqrstuvwxyz]{1,9}$/; // base32 geohash alphabet

/** Best-effort realtime fan-out to a cell's Durable Object. D1 is the source of
 *  truth, so a missed fan-out is cosmetic (the next GET / snapshot self-heals) —
 *  it must never fail the write. No-op when the realtime binding isn't configured. */
async function fanout(env: Env, cell: string, path: "publish" | "evict", payload: unknown): Promise<void> {
  const ns = env.SHADOW_CELL;
  if (!ns) return;
  try {
    const stub = ns.get(ns.idFromName(cell));
    await stub.fetch(new Request(`https://do/${path}`, { method: "POST", body: JSON.stringify(payload) }) as any);
  } catch {
    /* realtime is progressive enhancement — swallow */
  }
}

/** Schedule background work that outlives the response (the async moderation audit,
 *  live retraction). Returns the ExecutionContext, or null when there isn't one
 *  (unit tests) — in which case the audit simply doesn't run, keeping tests
 *  deterministic. Prod always has a ctx, so the audit always runs there. */
function bgCtx(c: any): { waitUntil(p: Promise<unknown>): void } | null {
  try {
    return c.executionCtx ?? null;
  } catch {
    return null;
  }
}
const modOpts = (env: Env) => ({ env, openrouterKey: env.OPENROUTER_MODERATION_KEY ?? null, model: env.OPENROUTER_MODERATION_MODEL ?? null });

/** Async LLM audit of a freshly-posted shadow. If the model blocks it, mark it
 *  blocked in D1 (hides it from every future read) and retract it live from the
 *  cell. This is the "cheap moderators audit the stream" pass — it runs per post,
 *  so moderation scales with activity, never a central bottleneck. */
async function auditNewShadow(env: Env, id: string, cell: string, body: string): Promise<void> {
  try {
    const v = await moderateText(body, modOpts(env));
    if (!v.allow) {
      await new ShadowsRepo(env.DB).setModeration(id, "blocked", v.reason);
      await fanout(env, cell, "evict", { id });
    }
  } catch {
    /* best-effort audit — never throw into waitUntil */
  }
}

/** Re-judge a reported (→pending) shadow: restore it or block it for good. */
async function reauditReported(env: Env, id: string): Promise<void> {
  try {
    const repo = new ShadowsRepo(env.DB);
    const s = await repo.getForModeration(id);
    if (!s || s.modStatus === "blocked") return;
    const v = await moderateText(s.body || "", modOpts(env));
    await repo.setModeration(id, v.allow ? "ok" : "blocked", v.reason);
    if (!v.allow) await fanout(env, s.cell, "evict", { id });
  } catch {
    /* best-effort */
  }
}

export function shadowsRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  // Live read: active shadows for a bounded set of fine cells (a zoomed-in viewport).
  app.get("/api/shadows", optionalAuth, async (c) => {
    const raw = (c.req.query("cells") || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const cells = [...new Set(raw)].filter((x) => CELL_RE.test(x)).slice(0, MAX_CELLS);
    const shadows = cells.length ? await repo(c).activeInCells(cells) : [];
    return c.json({ shadows });
  });

  // Zoomed-out heat: one cheap grouped count, short-TTL edge-cached — the whole-Bay
  // view never fans out per shadow, so it scales no matter how many cells are live.
  app.get("/api/shadows/heat", async (c) => {
    const p = Math.min(HEAT_MAX_P, Math.max(HEAT_MIN_P, Math.trunc(Number(c.req.query("precision")) || 4)));
    const cells = await repo(c).heat(p);
    c.header("Cache-Control", "public, max-age=10");
    return c.json({ precision: p, cells });
  });

  // The shadow you currently hold (drives the composer's "replace your shadow?").
  app.get("/api/shadows/mine", requireAuth, async (c) => c.json({ active: await repo(c).activeByAuthor(c.get("user")!.id) }));

  // WebSocket upgrade → this cell's Durable Object (live {new}/{expire} deltas on top
  // of the D1 snapshot the client already loaded). Signed-in — bounds live sockets to
  // real accounts; anonymous viewers still get the (edge-cacheable) GET snapshot.
  app.get("/api/shadows/ws", requireAuth, async (c) => {
    const cell = (c.req.query("cell") || "").trim().toLowerCase();
    if (!CELL_RE.test(cell)) return c.json({ error: "bad cell" }, 400);
    const ns = c.env.SHADOW_CELL;
    if (!ns) return c.json({ error: "realtime unavailable" }, 503);
    const stub = ns.get(ns.idFromName(cell));
    return stub.fetch(new Request("https://do/ws", c.req.raw as any) as any) as any;
  });

  // Cast a shadow — signed in AND physically in the Bay (GPS gate). Replaces your
  // previous shadow (1-per-account, handled in the repo), then fans out to the cell DO.
  app.post("/api/shadows", requireAuth, async (c) => {
    const parsed = ShadowPostSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad shadow", issues: parsed.error.issues.slice(0, 5) }, 400);
    const s = parsed.data;
    if (!inBay(s.lat, s.lng)) return c.json({ error: "you must be in the Bay to cast a shadow" }, 403);
    if (s.kind === "connection" && s.connectionUserId) {
      const who = await new SocialRepo(c.env.DB).getUserById(s.connectionUserId);
      if (!who) return c.json({ error: "that person isn't on the Bay" }, 400);
    }
    const author = c.get("user")!;
    const body = s.body?.trim() || null;
    // Instant deterministic hard-screen: the worst content never persists, even
    // with no LLM. The nuanced LLM audit runs async below so posting stays snappy.
    if (body) {
      const screen = screenText(body);
      if (!screen.allow) return c.json({ error: "held for community guidelines", reason: screen.reason }, 422);
    }
    const atIso = new Date().toISOString();
    const res = await repo(c).post(author.id, { ...s, body }, atIso);

    const ctx = bgCtx(c);
    if (body && ctx) ctx.waitUntil(auditNewShadow(c.env, res.id, res.cell, body)); // async LLM audit → live retract on block

    if (c.env.SHADOW_CELL && ctx) {
      const shadow = {
        id: res.id, authorId: author.id, lat: s.lat, lng: s.lng, cell: res.cell, kind: s.kind,
        body, mediaKey: s.mediaKey ?? null, streamId: s.streamId ?? null, connectionUserId: s.connectionUserId ?? null,
        createdAt: atIso, expiresAt: res.expiresAt,
        author: { id: author.id, displayName: author.displayName, handle: author.handle, avatarKey: author.avatarKey ?? null },
        reactions: {},
      };
      ctx.waitUntil(fanout(c.env, res.cell, "publish", shadow));
      if (res.replaced) ctx.waitUntil(fanout(c.env, res.replaced.cell, "evict", { id: res.replaced.id }));
    }
    return c.json({ ok: true, ...res });
  });

  // React (toggle on/off) — from the curated palette (validated in the schema).
  app.post("/api/shadows/:id/react", requireAuth, async (c) => {
    const parsed = ShadowReactSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad reaction" }, 400);
    const uid = c.get("user")!.id;
    try {
      if (parsed.data.on) await repo(c).react(c.req.param("id"), uid, parsed.data.emoji);
      else await repo(c).unreact(c.req.param("id"), uid, parsed.data.emoji);
    } catch {
      return c.json({ error: "no such shadow" }, 409); // FK: reacted to a gone shadow
    }
    return c.json({ ok: true });
  });

  // Report → hide pending re-audit; the async re-judge restores or blocks it.
  app.post("/api/shadows/:id/report", requireAuth, async (c) => {
    const id = c.req.param("id");
    await repo(c).report(id);
    const ctx = bgCtx(c);
    if (ctx) ctx.waitUntil(reauditReported(c.env, id));
    return c.json({ ok: true });
  });

  // Delete your own shadow (no-op for anyone else) + fade it from the live cell.
  app.delete("/api/shadows/:id", requireAuth, async (c) => {
    const id = c.req.param("id");
    const uid = c.get("user")!.id;
    const active = await repo(c).activeByAuthor(uid); // the one they hold (1-per-account)
    const deleted = await repo(c).deleteOwn(id, uid);
    const ctx = bgCtx(c);
    if (deleted && active?.id === id && ctx) ctx.waitUntil(fanout(c.env, active.cell, "evict", { id }));
    return c.json({ ok: true, deleted });
  });

  // Ephemeral media upload for a rich shadow. Deliberately separate from the
  // permanent events media library: a shadow's photo/voice/video lives and dies
  // with the shadow (the cron GC deletes these R2 keys via deleteExpired). Returns
  // the reference the composer then posts as { mediaKey } (photo/voice) or
  // { streamId } (video). ?kind=photo|voice|video.
  app.post("/api/shadows/media", requireAuth, async (c) => {
    const uid = c.get("user")!.id;
    const kind = c.req.query("kind");
    const type = c.req.header("content-type") || "";

    if (kind === "video") {
      if (!c.env.STREAM_TOKEN || !c.env.CF_ACCOUNT_ID) return c.json({ error: "video not configured" }, 503);
      const buf = await c.req.arrayBuffer();
      if (buf.byteLength > 200_000_000) return c.json({ error: "too large" }, 413);
      const up = await fetch(`https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/stream`, {
        method: "POST",
        headers: { authorization: `Bearer ${c.env.STREAM_TOKEN}`, "content-type": type || "video/mp4" },
        body: buf,
      });
      const j = (await up.json().catch(() => ({}))) as any;
      const streamId = j?.result?.uid;
      return streamId ? c.json({ ok: true, streamId }) : c.json({ error: "stream upload failed" }, 502);
    }

    if (kind === "photo" || kind === "voice") {
      const want = kind === "photo" ? "image/" : "audio/";
      if (!type.startsWith(want)) return c.json({ error: `${kind} requires ${want}* content` }, 400);
      const buf = await c.req.arrayBuffer();
      const cap = kind === "photo" ? 12_000_000 : 8_000_000;
      if (buf.byteLength > cap) return c.json({ error: "too large" }, 413);
      const key = `shadows/${uid}/${ulid()}`;
      await c.env.PHOTOS.put(key, buf, { httpMetadata: { contentType: type } });
      return c.json({ ok: true, mediaKey: key });
    }

    return c.json({ error: "kind must be photo, voice, or video" }, 400);
  });

  return app;
}
