import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { requireAuth } from "../../auth/middleware";
import { PlatformRepo } from "../../storage/d1/platform-repo";
import { GraphRepo } from "../../storage/d1/graph-repo";
import { buildResearchBrief } from "../../ai/research";
import { suggestNetworkActions } from "../../ai/agent";
import { chatComplete } from "../../ai/llm";

/* eslint-disable @typescript-eslint/no-explicit-any */
type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;

/** Optionally rephrase the deterministic summary with an LLM — the user's own
 *  OpenRouter key if they've set one, else Workers AI. Never changes the picks,
 *  only the prose, and falls back silently when no LLM is available. */
async function polish(env: Env, ai: { key: string | null; model: string | null }, brief: { summary: string }, context: string): Promise<string> {
  const text = await chatComplete(
    [
      { role: "system", content: "You are a concise networking strategist. Rewrite the brief in 2 crisp sentences. Do not invent names or facts beyond what's given." },
      { role: "user", content: `${context}\n\nDraft: ${brief.summary}` },
    ],
    { openrouterKey: ai.key, model: ai.model, maxTokens: 160, env },
  );
  return text && text.length > 20 ? text : brief.summary;
}

export function aiRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();
  const plat = (c: any) => new PlatformRepo(c.env.DB);
  const graph = (c: any) => new GraphRepo(c.env.DB);

  // ── event deep-research ───────────────────────────────────────────────────────
  app.get("/api/events/:id/research", requireAuth, async (c) => {
    const me = c.get("user")!;
    const eventId = c.req.param("id");
    const ev = await c.env.DB.prepare("SELECT id, title, start_utc AS startUtc, venue_name AS venueName FROM events WHERE id = ?").bind(eventId).first<any>();
    if (!ev) return c.json({ error: "not found" }, 404);

    const attendees = await graph(c).eventResearchAttendees(me.id, eventId);
    const goals = (await plat(c).listGoals(me.id)).map((g: any) => g.title);
    const interests = String(me.bio || "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

    const ai = await plat(c).getAiKey(me.id);
    const brief = buildResearchBrief({ event: { title: ev.title, venueName: ev.venueName, startUtc: ev.startUtc }, attendees, goals, interests });
    brief.summary = await polish(c.env, ai, brief, `Event: ${ev.title}. Your goals: ${goals.join("; ") || "networking"}.`);
    return c.json({ brief, aiEnhanced: !!(ai.key || c.env.AI) });
  });

  // ── networking agent: settings ────────────────────────────────────────────────
  app.get("/api/me/agent", requireAuth, async (c) => c.json(await plat(c).getAgentSettings(c.get("user")!.id)));
  app.put("/api/me/agent", requireAuth, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean; mode?: string; openrouterKey?: string; openrouterModel?: string };
    const me = c.get("user")!.id;
    const cur = await plat(c).getAgentSettings(me);
    // Preserve the current mode when the caller doesn't send one (partial updates
    // like toggling `enabled` or saving the AI key must not reset autopilot).
    const mode = body.mode === "auto" ? "auto" : body.mode === "approve" ? "approve" : cur.mode;
    await plat(c).setAgentSettings(me, body.enabled ?? cur.enabled, { ...cur.guardrails, mode });
    // bring-your-own OpenRouter key: set when a non-empty string is sent, clear on "".
    if (body.openrouterKey !== undefined) {
      const key = body.openrouterKey.trim() || null;
      await plat(c).setAiKey(me, key, key ? (body.openrouterModel?.trim() || null) : null);
    }
    return c.json(await plat(c).getAgentSettings(me));
  });

  // ── networking agent: suggestions (the agent proposes; you approve each) ────────
  app.get("/api/me/agent/suggestions", requireAuth, async (c) => {
    const me = c.get("user")!;
    const candidates = await graph(c).networkCandidates(me.id, 20);
    const goals = (await plat(c).listGoals(me.id)).map((g: any) => g.title);
    const interests = String(me.bio || "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    const suggestions = suggestNetworkActions({ goals, interests, candidates }, 6);
    return c.json({ suggestions });
  });

  return app;
}
