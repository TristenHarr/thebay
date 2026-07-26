import type { D1Database } from "@cloudflare/workers-types";
import { ulid } from "ulid";
import type { FormDFiling } from "../../news/ingest/formd";
import { companySlug, normalizePersonName } from "../../core/attribution/normalize";
import { generateCandidates, confirmationQuestion, type Candidate, type UserRef } from "../../core/attribution/identity";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const nowIso = () => new Date().toISOString();

/** D1 caps a statement at 100 bound parameters. 80 leaves room for the extra
 *  binds (viewer id, timestamps) the queries below carry alongside an id list. */
const CHUNK = 80;

export interface CompanyRow {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  cik: string | null;
  city: string | null;
  state: string | null;
  industry: string | null;
  yearFounded: number | null;
  description: string | null;
  source: string;
}
export interface RoundRow {
  id: string;
  kind: string;
  stage: string | null;
  amountUsd: number | null;
  amountSoldUsd: number | null;
  filedAt: string | null;
  firstSaleAt: string | null;
  source: string;
  sourceUrl: string | null;
  externalId: string | null;
}
/**
 * A person as a company page renders them. `handle`/`userId` are populated ONLY
 * for a confirmed match — see the class doc.
 */
export interface CompanyPersonRow {
  personName: string;
  role: string;
  source: string;
  confirmed: boolean;
  userId: string | null;
  handle: string | null;
  displayName: string | null;
  confidence: number | null;
}
export interface StoryCompanyFacts {
  companyId: string;
  name: string;
  slug: string;
  city: string | null;
  industry: string | null;
  amountUsd: number | null;
  amountSoldUsd: number | null;
  roundSource: string | null;
  filedAt: string | null;
  /** Confirmed people at this company who are in the viewer's network. */
  peopleInNetwork: number;
}
export interface MatchOffer {
  company: { id: string; name: string; slug: string };
  person: { companyId: string; personName: string; role: string };
  candidate: Candidate;
  /** The literal question the person answers. */
  question: string;
}

/**
 * CompaniesRepo — companies, the rounds they file, and the people named on those
 * filings.
 *
 * THE ONE RULE THIS CLASS ENFORCES: a name on a Form D is not an account.
 * `company_people.user_id` starts null and can only be set by
 * {@link confirmPerson}, which re-derives the deterministic candidate set
 * server-side before it will write anything — so "@annlee raised $4.2M" can only
 * ever be published because Ann said it was her. Every public read path
 * (`bySlug`, `factsForStories`) treats an unresolved row as a name and a role and
 * nothing more.
 */
export class CompaniesRepo {
  constructor(private db: D1Database) {}

  private async chunked<T>(ids: string[], run: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await run(ids.slice(i, i + CHUNK))));
    return out;
  }

  /** First unused slug from `base`. Uniqueness itself is the DB's (UNIQUE) job. */
  private async allocSlug(base: string): Promise<string> {
    const b = base || "company";
    for (let i = 1; i <= 50; i++) {
      const s = i === 1 ? b : `${b}-${i}`;
      if (!(await this.db.prepare("SELECT 1 FROM companies WHERE slug = ?").bind(s).first())) return s;
    }
    return `${b}-${ulid().slice(-6).toLowerCase()}`;
  }

  // ── ingest ──────────────────────────────────────────────────────────────────

  /**
   * Which of these SEC accession numbers we have never stored. The per-tick Form D
   * budget is small, so spending it re-fetching filings we already have would mean
   * never catching up. Chunked for D1's parameter cap.
   */
  async unseenAccessions(accessions: string[]): Promise<string[]> {
    const asked = [...new Set((accessions ?? []).filter(Boolean))];
    if (asked.length === 0) return [];
    const seen = new Set(
      (
        await this.chunked(asked, async (chunk) => {
          const ph = chunk.map(() => "?").join(",");
          const r = await this.db
            .prepare(`SELECT external_id FROM funding_rounds WHERE source='sec' AND external_id IN (${ph})`)
            .bind(...chunk)
            .all<{ external_id: string }>();
          return r.results ?? [];
        })
      ).map((r) => r.external_id),
    );
    return asked.filter((a) => !seen.has(a));
  }

  /**
   * One Form D → a company, a round, and one row per (person, relationship).
   *
   * Idempotent on the accession number, so the 15-minute cron can re-see the same
   * filing forever. Returns null for a filing with no usable issuer name — SKIP
   * THE BAD ITEM, never abort the run.
   */
  async upsertFromFormD(f: FormDFiling): Promise<{ companyId: string; roundId: string; companyCreated: boolean; roundCreated: boolean; people: number } | null> {
    const name = String(f?.entityName ?? "").trim();
    const base = companySlug(name);
    if (!name || !base) return null;
    const ts = nowIso();

    // The CIK is the identity. Only fall back to the slug for a company someone
    // declared here BEFORE it ever filed (that row has no CIK yet) — a slug clash
    // between two different CIKs is two different companies.
    let existing: Row | null = f.cik ? await this.db.prepare("SELECT id, cik FROM companies WHERE cik = ?").bind(f.cik).first<Row>() : null;
    if (!existing) {
      const bySlug = await this.db.prepare("SELECT id, cik FROM companies WHERE slug = ?").bind(base).first<Row>();
      if (bySlug && !bySlug.cik) existing = bySlug;
    }

    let companyId: string;
    let companyCreated = false;
    if (existing) {
      companyId = existing.id;
      // Public record wins on the factual fields, but never clobbers what we have
      // with a null.
      await this.db
        .prepare(
          `UPDATE companies SET cik = COALESCE(cik, ?), city = COALESCE(?, city), state = COALESCE(?, state),
             industry = COALESCE(?, industry), year_founded = COALESCE(?, year_founded), source = 'sec', updated_at = ?
           WHERE id = ?`,
        )
        .bind(f.cik || null, f.city, f.state, f.industryGroup, f.yearOfInc, ts, companyId)
        .run();
    } else {
      companyId = ulid();
      companyCreated = true;
      await this.db
        .prepare(
          `INSERT INTO companies (id, name, slug, domain, cik, city, state, industry, year_founded, description, source, created_at, updated_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, 'sec', ?, ?)`,
        )
        .bind(companyId, name, await this.allocSlug(base), f.cik || null, f.city, f.state, f.industryGroup, f.yearOfInc, ts, ts)
        .run();
    }

    const prior = await this.db
      .prepare("SELECT id FROM funding_rounds WHERE source='sec' AND external_id = ?")
      .bind(f.accessionNumber)
      .first<{ id: string }>();
    const roundId = prior?.id ?? ulid();
    await this.db
      .prepare(
        // `stage` stays NULL deliberately: a Form D states an amount, never a stage.
        `INSERT INTO funding_rounds (id, company_id, kind, stage, amount_usd, amount_sold_usd, filed_at, first_sale_at, source, source_url, external_id, created_at)
         VALUES (?, ?, 'form-d', NULL, ?, ?, ?, ?, 'sec', ?, ?, ?)
         ON CONFLICT(source, external_id) DO UPDATE SET
           amount_usd = excluded.amount_usd, amount_sold_usd = excluded.amount_sold_usd,
           filed_at = excluded.filed_at, first_sale_at = excluded.first_sale_at, source_url = excluded.source_url`,
      )
      .bind(roundId, companyId, f.totalOfferingAmount, f.totalAmountSold, f.filedAt, f.dateOfFirstSale, f.sourceUrl, f.accessionNumber, ts)
      .run();

    let people = 0;
    for (const p of f.relatedPersons ?? []) {
      const person = String(p?.name ?? "").trim();
      if (!person) continue; // skip the bad item, keep the filing
      const roles = p.relationships?.length ? p.relationships : ["Related Person"];
      for (const role of roles) {
        // user_id / confirmed_at stay NULL. However obvious the name looks, this
        // is a name on a document until the person says otherwise.
        const r = await this.db
          .prepare(
            `INSERT OR IGNORE INTO company_people (company_id, person_name, user_id, role, source, confidence, confirmed_at, created_at)
             VALUES (?, ?, NULL, ?, 'sec', NULL, NULL, ?)`,
          )
          .bind(companyId, person, role, ts)
          .run();
        people += (r as any).meta?.changes ?? 0;
      }
    }

    return { companyId, roundId, companyCreated, roundCreated: !prior, people };
  }

  /**
   * Attach each SEC news story to the company its filing belongs to, by accession
   * number — `story_sources` already stores the accession as `external_id`, so no
   * new fetch is needed. Idempotent; returns how many links were new.
   */
  async linkStoriesByAccession(): Promise<number> {
    const r = await this.db
      .prepare(
        `INSERT OR IGNORE INTO story_companies (story_id, company_id, round_id, created_at)
         SELECT ss.story_id, r.company_id, r.id, ?
           FROM story_sources ss
           JOIN funding_rounds r ON r.source = 'sec' AND r.external_id = ss.external_id
          WHERE ss.origin = 'sec'`,
      )
      .bind(nowIso())
      .run();
    return (r as any).meta?.changes ?? 0;
  }

  /** Attach a company (and optionally the round) to a story by hand. */
  async linkStory(storyId: string, companyId: string, roundId?: string | null): Promise<void> {
    await this.db
      .prepare("INSERT OR IGNORE INTO story_companies (story_id, company_id, round_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(storyId, companyId, roundId ?? null, nowIso())
      .run();
  }

  // ── read ────────────────────────────────────────────────────────────────────

  async list(opts: { limit?: number; offset?: number; q?: string } = {}): Promise<{ companies: Array<CompanyRow & { latestAmountUsd: number | null; latestFiledAt: string | null; peopleCount: number }>; total: number }> {
    const limit = Math.min(100, Math.max(1, Number(opts.limit) || 30));
    const offset = Math.max(0, Number(opts.offset) || 0);
    const q = String(opts.q ?? "").trim().toLowerCase();
    const where = q ? "WHERE lower(c.name) LIKE ?" : "";
    const like = `%${q}%`;

    const totalStmt = this.db.prepare(`SELECT COUNT(*) AS n FROM companies c ${where}`);
    const total = (await (q ? totalStmt.bind(like) : totalStmt).first<{ n: number }>())?.n ?? 0;

    const sql = `SELECT c.id, c.name, c.slug, c.domain, c.cik, c.city, c.state, c.industry,
                        c.year_founded AS yearFounded, c.description, c.source,
                        (SELECT r.amount_usd FROM funding_rounds r WHERE r.company_id = c.id ORDER BY r.filed_at DESC LIMIT 1) AS latestAmountUsd,
                        (SELECT MAX(r.filed_at) FROM funding_rounds r WHERE r.company_id = c.id) AS latestFiledAt,
                        (SELECT COUNT(*) FROM company_people cp WHERE cp.company_id = c.id) AS peopleCount
                   FROM companies c ${where}
                  ORDER BY (latestFiledAt IS NULL), latestFiledAt DESC, c.created_at DESC
                  LIMIT ? OFFSET ?`;
    const stmt = this.db.prepare(sql);
    const res = await (q ? stmt.bind(like, limit, offset) : stmt.bind(limit, offset)).all<Row>();
    return { companies: (res.results ?? []) as any, total };
  }

  async bySlug(slug: string): Promise<{ company: CompanyRow; rounds: RoundRow[]; people: CompanyPersonRow[] } | null> {
    const company = await this.db
      .prepare(
        `SELECT id, name, slug, domain, cik, city, state, industry, year_founded AS yearFounded, description, source
           FROM companies WHERE slug = ?`,
      )
      .bind(slug)
      .first<Row>();
    if (!company) return null;
    return { company: company as any, rounds: await this.rounds(company.id), people: await this.people(company.id) };
  }

  async rounds(companyId: string): Promise<RoundRow[]> {
    const res = await this.db
      .prepare(
        `SELECT id, kind, stage, amount_usd AS amountUsd, amount_sold_usd AS amountSoldUsd,
                filed_at AS filedAt, first_sale_at AS firstSaleAt, source, source_url AS sourceUrl, external_id AS externalId
           FROM funding_rounds WHERE company_id = ? ORDER BY (filed_at IS NULL), filed_at DESC, created_at DESC`,
      )
      .bind(companyId)
      .all<Row>();
    return (res.results ?? []) as any;
  }

  /**
   * The people on a company's filings. The JOIN to `users` is on `cp.user_id`,
   * which the schema only permits on a self-confirmed row — so an unconfirmed
   * Form D name comes back with `handle: null` by construction, not by a filter
   * somebody has to remember to write.
   */
  async people(companyId: string): Promise<CompanyPersonRow[]> {
    const res = await this.db
      .prepare(
        `SELECT cp.person_name AS personName, cp.role, cp.source, cp.confidence, cp.user_id AS userId,
                u.handle, u.display_name AS displayName
           FROM company_people cp
           LEFT JOIN users u ON u.id = cp.user_id
          WHERE cp.company_id = ?
          ORDER BY cp.person_name, cp.role`,
      )
      .bind(companyId)
      .all<Row>();
    return (res.results ?? []).map((r) => ({
      personName: r.personName,
      role: r.role,
      source: r.source,
      confirmed: r.userId != null,
      userId: r.userId ?? null,
      handle: r.handle ?? null,
      displayName: r.displayName ?? null,
      confidence: r.confidence ?? null,
    }));
  }

  /**
   * Company facts per story id — what turns "Acme Robotics filed a Form D" into
   * "Acme Robotics — $4.2M · 2 founders in your network" on the news front page.
   * `peopleInNetwork` counts CONFIRMED people only.
   */
  async factsForStories(storyIds: string[], viewerId?: string | null): Promise<Record<string, StoryCompanyFacts>> {
    const ids = [...new Set((storyIds ?? []).filter(Boolean))];
    if (ids.length === 0) return {};
    const out: Record<string, StoryCompanyFacts> = {};

    const rows = await this.chunked(ids, async (chunk) => {
      const ph = chunk.map(() => "?").join(",");
      const r = await this.db
        .prepare(
          `SELECT sc.story_id AS storyId, c.id AS companyId, c.name, c.slug, c.city, c.industry,
                  r.amount_usd AS amountUsd, r.amount_sold_usd AS amountSoldUsd, r.source AS roundSource, r.filed_at AS filedAt
             FROM story_companies sc
             JOIN companies c ON c.id = sc.company_id
             LEFT JOIN funding_rounds r ON r.id = sc.round_id
            WHERE sc.story_id IN (${ph})`,
        )
        .bind(...chunk)
        .all<Row>();
      return r.results ?? [];
    });
    for (const r of rows) {
      out[r.storyId] = {
        companyId: r.companyId,
        name: r.name,
        slug: r.slug,
        city: r.city ?? null,
        industry: r.industry ?? null,
        amountUsd: r.amountUsd ?? null,
        amountSoldUsd: r.amountSoldUsd ?? null,
        roundSource: r.roundSource ?? null,
        filedAt: r.filedAt ?? null,
        peopleInNetwork: 0,
      };
    }
    if (!viewerId) return out;

    const counts = await this.chunked(ids, async (chunk) => {
      const ph = chunk.map(() => "?").join(",");
      const r = await this.db
        .prepare(
          `SELECT sc.story_id AS storyId, COUNT(DISTINCT cp.user_id) AS n
             FROM story_companies sc
             JOIN company_people cp ON cp.company_id = sc.company_id AND cp.user_id IS NOT NULL
             JOIN friendships f ON f.status = 'accepted'
                  AND ((f.user_low = ? AND f.user_high = cp.user_id) OR (f.user_high = ? AND f.user_low = cp.user_id))
            WHERE sc.story_id IN (${ph})
            GROUP BY sc.story_id`,
        )
        .bind(viewerId, viewerId, ...chunk)
        .all<Row>();
      return r.results ?? [];
    });
    for (const c of counts) if (out[c.storyId]) out[c.storyId]!.peopleInNetwork = Number(c.n) || 0;
    return out;
  }

  // ── identity resolution ─────────────────────────────────────────────────────

  /** The LinkedIn company/position an importer stored for this member. A signal
   *  about them recorded by someone else — never a link, never published. */
  async linkedinSignals(userId: string): Promise<{ company: string | null; position: string | null }> {
    const r = await this.db
      .prepare(
        `SELECT json_extract(ii.payload_json, '$.company') AS company,
                json_extract(ii.payload_json, '$.position') AS position
           FROM imported_items ii
           JOIN users u ON lower(u.email) = lower(json_extract(ii.payload_json, '$.email'))
          WHERE u.id = ? AND ii.kind = 'connection'
            AND coalesce(json_extract(ii.payload_json, '$.company'), '') <> ''
          ORDER BY ii.created_at DESC LIMIT 1`,
      )
      .bind(userId)
      .first<Row>();
    return { company: r?.company ?? null, position: r?.position ?? null };
  }

  private async userRef(userId: string): Promise<UserRef | null> {
    const u = await this.db
      .prepare("SELECT id, handle, display_name AS displayName, email FROM users WHERE id = ?")
      .bind(userId)
      .first<Row>();
    if (!u) return null;
    const sig = await this.linkedinSignals(userId);
    const declared = await this.db.prepare("SELECT company_id FROM user_companies WHERE user_id = ?").bind(userId).all<Row>();
    return {
      id: u.id,
      handle: u.handle,
      displayName: u.displayName,
      email: u.email,
      importedCompany: sig.company,
      importedPosition: sig.position,
      declaredCompanyIds: (declared.results ?? []).map((r) => r.company_id),
    };
  }

  /**
   * Unresolved filing names that deterministically match this member — i.e. the
   * questions we may ask them. Narrowed in SQL by surname, then scored by the pure
   * {@link generateCandidates}, so the rule for who becomes a candidate lives in
   * one readable place and is the same rule {@link confirmPerson} re-checks.
   */
  async candidatesForUser(userId: string): Promise<MatchOffer[]> {
    const me = await this.userRef(userId);
    if (!me) return [];
    const parts = normalizePersonName(me.displayName).split(" ").filter(Boolean);
    const surname = parts[parts.length - 1];
    if (!surname) return [];

    const rows = await this.db
      .prepare(
        `SELECT cp.company_id AS companyId, cp.person_name AS personName, cp.role,
                c.name AS companyName, c.slug, c.domain
           FROM company_people cp
           JOIN companies c ON c.id = cp.company_id
          WHERE cp.user_id IS NULL AND lower(cp.person_name) LIKE ?
          ORDER BY cp.created_at DESC LIMIT 200`,
      )
      .bind(`%${surname}%`)
      .all<Row>();

    const out: MatchOffer[] = [];
    for (const r of rows.results ?? []) {
      const person = { name: r.personName, role: r.role };
      const company = { id: r.companyId, name: r.companyName, domain: r.domain };
      const [candidate] = generateCandidates(person, company, [me]);
      if (!candidate) continue;
      out.push({
        company: { id: r.companyId, name: r.companyName, slug: r.slug },
        person: { companyId: r.companyId, personName: r.personName, role: r.role },
        candidate,
        question: confirmationQuestion(person, company),
      });
    }
    return out.sort((a, b) => b.candidate.score - a.candidate.score);
  }

  /**
   * The person confirms: "yes, that Ann Lee is me." The ONLY writer of
   * `company_people.user_id`.
   *
   * Candidacy is re-derived here rather than trusted from the request — the
   * request only says which row is being claimed, exactly as `forwardIntro`
   * re-verifies eligibility instead of trusting the inbox that displayed it.
   * Otherwise anyone could POST themselves onto any filing in the country.
   */
  async confirmPerson(userId: string, companyId: string, personName: string, role: string): Promise<"confirmed" | "taken" | "unknown" | "not_a_candidate"> {
    const row = await this.db
      .prepare("SELECT user_id FROM company_people WHERE company_id = ? AND person_name = ? AND role = ?")
      .bind(companyId, personName, role)
      .first<Row>();
    if (!row) return "unknown";
    if (row.user_id) return row.user_id === userId ? "confirmed" : "taken";

    const eligible = (await this.candidatesForUser(userId)).some(
      (m) => m.person.companyId === companyId && m.person.personName === personName && m.person.role === role,
    );
    if (!eligible) return "not_a_candidate";

    const ts = nowIso();
    await this.db
      .prepare(
        `UPDATE company_people SET user_id = ?, source = 'self', confidence = NULL, confirmed_at = ?
          WHERE company_id = ? AND person_name = ? AND role = ? AND user_id IS NULL`,
      )
      .bind(userId, ts, companyId, personName, role)
      .run();
    // Confirming a filing role is also a statement about where they work.
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO user_companies (user_id, company_id, role, title, is_current, source, created_at)
         VALUES (?, ?, ?, ?, 1, 'self', ?)`,
      )
      .bind(userId, companyId, role, role, ts)
      .run();
    return "confirmed";
  }

  /** Release a confirmed match (a mistake, or they left). Only the holder may. */
  async releasePerson(userId: string, companyId: string, personName: string, role: string): Promise<boolean> {
    const r = await this.db
      .prepare(
        `UPDATE company_people SET user_id = NULL, source = 'sec', confirmed_at = NULL
          WHERE company_id = ? AND person_name = ? AND role = ? AND user_id = ?`,
      )
      .bind(companyId, personName, role, userId)
      .run();
    return ((r as any).meta?.changes ?? 0) > 0;
  }

  // ── self-declared employment ────────────────────────────────────────────────

  /** Find or create a company by name, attaching to an existing row when the
   *  normalized name already exists (so a declaration never forks a SEC company). */
  private async findOrCreateByName(name: string, source: "user" | "import"): Promise<string | null> {
    const clean = String(name ?? "").trim();
    const base = companySlug(clean);
    if (!clean || !base) return null;
    const hit = await this.db.prepare("SELECT id FROM companies WHERE slug = ?").bind(base).first<Row>();
    if (hit) return hit.id;
    const id = ulid();
    const ts = nowIso();
    await this.db
      .prepare("INSERT INTO companies (id, name, slug, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, clean, await this.allocSlug(base), source, ts, ts)
      .run();
    return id;
  }

  /** A member says where they work. `users` has no company column at all, so this
   *  is the first structured answer to "who is this founder". */
  async declareCompany(userId: string, p: { name?: string; companyId?: string; role: string; title?: string; isCurrent?: boolean }): Promise<string | null> {
    const companyId = p.companyId ?? (await this.findOrCreateByName(p.name ?? "", "user"));
    if (!companyId) return null;
    await this.db
      .prepare(
        `INSERT INTO user_companies (user_id, company_id, role, title, is_current, source, created_at)
         VALUES (?, ?, ?, ?, ?, 'self', ?)
         ON CONFLICT(user_id, company_id, role) DO UPDATE SET title = excluded.title, is_current = excluded.is_current`,
      )
      .bind(userId, companyId, p.role || "member", p.title ?? null, p.isCurrent === false ? 0 : 1, nowIso())
      .run();
    return companyId;
  }

  async companiesForUser(userId: string): Promise<Array<{ companyId: string; name: string; slug: string; role: string; title: string | null; isCurrent: boolean; source: string }>> {
    const res = await this.db
      .prepare(
        `SELECT uc.company_id AS companyId, c.name, c.slug, uc.role, uc.title, uc.is_current AS isCurrent, uc.source
           FROM user_companies uc JOIN companies c ON c.id = uc.company_id
          WHERE uc.user_id = ? ORDER BY uc.is_current DESC, uc.created_at DESC`,
      )
      .bind(userId)
      .all<Row>();
    return (res.results ?? []).map((r) => ({ ...r, isCurrent: !!r.isCurrent })) as any;
  }

  /**
   * Adopt what an importer already knows: `imported_items.payload_json.$.company`
   * and `$.position`, written by the LinkedIn importer since day one and never
   * read by anything. It is a THIRD PARTY's note about this member, so it becomes
   * a declaration only when the member themselves runs this — hence `userId`, not
   * a background sweep.
   */
  async adoptImportedEmployment(userId: string): Promise<number> {
    const res = await this.db
      .prepare(
        `SELECT DISTINCT json_extract(ii.payload_json, '$.company') AS company,
                         json_extract(ii.payload_json, '$.position') AS position
           FROM imported_items ii
           JOIN users u ON lower(u.email) = lower(json_extract(ii.payload_json, '$.email'))
          WHERE u.id = ? AND ii.kind = 'connection'
            AND coalesce(json_extract(ii.payload_json, '$.company'), '') <> ''`,
      )
      .bind(userId)
      .all<Row>();

    let created = 0;
    const ts = nowIso();
    for (const r of res.results ?? []) {
      const companyId = await this.findOrCreateByName(r.company, "import");
      if (!companyId) continue;
      const pos = String(r.position ?? "");
      const role = /\bco-?founder|founder\b/i.test(pos) ? "founder" : /\bdirector|board\b/i.test(pos) ? "director" : "member";
      const ins = await this.db
        .prepare(
          `INSERT OR IGNORE INTO user_companies (user_id, company_id, role, title, is_current, source, created_at)
           VALUES (?, ?, ?, ?, 1, 'import', ?)`,
        )
        .bind(userId, companyId, role, pos || null, ts)
        .run();
      created += (ins as any).meta?.changes ?? 0;
    }
    return created;
  }
}
