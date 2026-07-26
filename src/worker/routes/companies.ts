import { Hono } from "hono";
import { z } from "zod";
import type { Env, Vars } from "../env";
import { CompaniesRepo } from "../../storage/d1/companies-repo";
import { requireAuth } from "../../auth/middleware";
import { rankCandidates } from "../../core/attribution/rank";

/**
 * Companies and funding rounds, sourced from SEC Form D filings.
 *
 * Two public reads (the directory and one company), plus the identity-resolution
 * flow — the only way `company_people.user_id` is ever set. The routes stay thin:
 * candidacy is re-derived inside {@link CompaniesRepo.confirmPerson} rather than
 * trusted from the request, so a forged POST cannot weld a stranger's @handle to
 * a real person's SEC filing.
 */
type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;
const repo = (c: { env: Env }) => new CompaniesRepo(c.env.DB);

const PersonRefSchema = z.object({ personName: z.string().min(1).max(200), role: z.string().min(1).max(80) });
const DeclareSchema = z.object({
  name: z.string().trim().min(1).max(200),
  role: z.string().min(1).max(60).default("member"),
  title: z.string().max(120).optional(),
  isCurrent: z.boolean().optional(),
});

export function companiesRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  // ── public directory ────────────────────────────────────────────────────────
  app.get("/api/companies", async (c) =>
    c.json(
      await repo(c).list({
        q: c.req.query("q") || undefined,
        limit: Number(c.req.query("limit")) || 30,
        offset: Number(c.req.query("offset")) || 0,
      }),
    ),
  );

  // ── self-declared employment ────────────────────────────────────────────────
  app.get("/api/me/companies", requireAuth, async (c) => c.json({ companies: await repo(c).companiesForUser(c.get("user")!.id) }));

  app.post("/api/me/companies", requireAuth, async (c) => {
    const p = DeclareSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "invalid" }, 400);
    const id = await repo(c).declareCompany(c.get("user")!.id, p.data);
    return id ? c.json({ ok: true, companyId: id }) : c.json({ error: "invalid" }, 400);
  });

  /** Adopt the company/position an importer recorded for you. YOUR act, not the
   *  importer's — a third party's note only becomes your declaration here. */
  app.post("/api/me/companies/import", requireAuth, async (c) =>
    c.json({ ok: true, adopted: await repo(c).adoptImportedEmployment(c.get("user")!.id) }),
  );

  /**
   * Unresolved filing names that deterministically match you — the questions we
   * may ask. A model may reorder them; that is its entire role in identity
   * resolution, and the deterministic order stands whenever it is unavailable.
   */
  app.get("/api/me/company-matches", requireAuth, async (c) => {
    const matches = await repo(c).candidatesForUser(c.get("user")!.id);
    if (matches.length < 2 || !c.env.OPENROUTER_API_KEY) return c.json({ matches });
    const ranked = await rankCandidates(
      { name: matches[0]!.person.personName, role: matches[0]!.person.role },
      matches[0]!.company,
      matches.map((m) => m.candidate),
      {
        openrouterKey: c.env.OPENROUTER_API_KEY,
        model: c.env.OPENROUTER_MODEL_QUALITY,
        cache: c.env.SESSIONS as unknown as null,
        dailyBudgetUsd: Number(c.env.LLM_DAILY_BUDGET_USD) || null,
      },
    ).catch(() => null);
    if (!ranked) return c.json({ matches });
    // Reorder the offers to match; every offer is kept, exactly as applyRanking does.
    const key = (m: { person: { companyId: string; personName: string; role: string } }) => `${m.person.companyId}|${m.person.personName}|${m.person.role}`;
    const rank = new Map(ranked.map((r, i) => [r.userId, i]));
    return c.json({ matches: [...matches].sort((a, b) => (rank.get(a.candidate.userId) ?? 0) - (rank.get(b.candidate.userId) ?? 0) || key(a).localeCompare(key(b))) });
  });

  // ── identity resolution: the person confirms, and only the person ───────────
  app.post("/api/companies/:id/people/confirm", requireAuth, async (c) => {
    const p = PersonRefSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "invalid" }, 400);
    const result = await repo(c).confirmPerson(c.get("user")!.id, c.req.param("id"), p.data.personName, p.data.role);
    return c.json({ result }, result === "confirmed" ? 200 : result === "unknown" ? 404 : 403);
  });

  app.post("/api/companies/:id/people/release", requireAuth, async (c) => {
    const p = PersonRefSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "invalid" }, 400);
    return c.json({ released: await repo(c).releasePerson(c.get("user")!.id, c.req.param("id"), p.data.personName, p.data.role) });
  });

  // ── one company (public). Last, so the literal paths above always win. ──────
  app.get("/api/companies/:slug", async (c) => {
    const found = await repo(c).bySlug(c.req.param("slug"));
    return found ? c.json(found) : c.json({ error: "not found" }, 404);
  });

  return app;
}
