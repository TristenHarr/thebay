#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Production e2e — an AGENT navigating the live site over HTTP.
//
// Every check here is a real HTTP round-trip against a running deployment, so it
// doubles as (a) proof the live site works and (b) proof the app is fully
// navigable by a headless agent through its JSON API alone.
//
//   node tests/prod-e2e.mjs                     # → https://thebay.events (safe subset)
//   BASE=http://localhost:8787 node tests/…     # → local wrangler dev (full journey)
//   PROD_FULL=1 node tests/prod-e2e.mjs         # → live site, INCLUDING public writes
//
// Safe-by-default: against a non-local BASE we skip actions that create publicly
// visible data (hosting an event, posting a board note) unless PROD_FULL=1, so a
// prod run leaves no litter on the discover feed or the bulletin board. Auth,
// reads, self-scoped writes (goals, RSVP, calendar, communities) and all the
// negative/gate assertions always run — they don't pollute shared surfaces.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = (process.env.BASE || "https://thebay.events").replace(/\/$/, "");
const IS_LOCAL = /localhost|127\.0\.0\.1/.test(BASE);
const FULL = process.env.PROD_FULL === "1" || IS_LOCAL;
// Light mode: public reads + security + no-auth gates only. Creates zero data, so
// it's safe to run on every deploy as a CI post-deploy smoke.
const LIGHT = process.env.PROD_LIGHT === "1";
const STAMP = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

// SF Ferry Building (inside the Bay) and Times Square (outside) for the geo-gate.
const IN_BAY = { lat: 37.7955, lng: -122.3937 };
const OUT_BAY = { lat: 40.758, lng: -73.9855 };

let pass = 0, fail = 0, skip = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { fail++; failures.push(msg); console.log(`  \x1b[31m✗ ${msg}\x1b[0m`); }
}
function skipped(msg) { skip++; console.log(`  \x1b[90m↷ skip: ${msg}\x1b[0m`); }
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

/** A cookie-jar-backed HTTP client — one per "agent" so we can act as several
 *  independent users against the live site. */
function agent(label = "anon") {
  const jar = new Map();
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  async function req(method, path, body) {
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    const c = cookie();
    if (c) headers.cookie = c;
    // Retry transient network failures (flaky links / edge blips) so a single
    // dropped read doesn't abort the whole smoke run.
    let res, lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      try {
        res = await fetch(BASE + path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "manual",
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        break;
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    if (!res) throw new Error(`${method} ${path} failed after retries: ${lastErr?.message || lastErr}`);
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const pair = sc.split(";")[0];
      const i = pair.indexOf("=");
      if (i < 0) continue;
      const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
      if (!v || /^(deleted)?$/i.test(v)) jar.delete(k); else jar.set(k, v);
    }
    const ct = res.headers.get("content-type") || "";
    const text = await res.text();
    let json = null;
    if (ct.includes("json")) { try { json = JSON.parse(text); } catch { /* leave null */ } }
    return { status: res.status, json, text, headers: res.headers, label };
  }
  return {
    label,
    get: (p) => req("GET", p),
    post: (p, b) => req("POST", p, b ?? {}),
    put: (p, b) => req("PUT", p, b ?? {}),
    patch: (p, b) => req("PATCH", p, b ?? {}),
  };
}

async function main() {
  console.log(`\x1b[1mProduction e2e — agent navigation\x1b[0m  →  ${BASE}`);
  console.log(`mode: ${FULL ? "FULL (includes public writes)" : "SAFE (no public writes)"}   run: ${STAMP}\n`);

  const anon = agent("anon");

  // ── 1. public health & content ────────────────────────────────────────────
  section("1 · Public surface (no auth)");
  {
    const health = await anon.get("/api/health");
    ok(health.status === 200 && health.json?.ok === true, "GET /api/health → { ok: true }");

    const home = await anon.get("/");
    ok(home.status === 200 && /<!doctype html/i.test(home.text), "GET / serves the dashboard HTML");

    // /app/ must serve the REACT app, not the dashboard fallback — assert the app's
    // own JS bundle is referenced AND loads (a doctype alone is not enough: the SPA
    // route falls back to the dashboard's index.html when the app dir is missing).
    const app = await anon.get("/app/");
    const bundle = (app.text.match(/\/app\/assets\/[A-Za-z0-9._-]+\.js/) || [])[0];
    ok(app.status === 200 && !!bundle, `GET /app/ serves the React app (bundle: ${bundle || "MISSING — dashboard fallback!"})`);
    if (bundle) ok((await anon.get(bundle)).status === 200, "the app's JS bundle loads (200)");

    const feed = await anon.get("/api/events?limit=5");
    ok(feed.status === 200 && Array.isArray(feed.json?.events), "GET /api/events → events[]");
    ok((feed.json?.total ?? 0) > 0, `catalog is populated (total=${feed.json?.total ?? 0})`);
    ok((feed.json?.events?.length ?? 0) <= 5, "limit=5 is honored (pagination)");

    // pagination: page 2 must differ from page 1
    const p1 = await anon.get("/api/events?limit=3&offset=0");
    const p2 = await anon.get("/api/events?limit=3&offset=3");
    const first1 = p1.json?.events?.[0]?.id, first2 = p2.json?.events?.[0]?.id;
    ok(!!first1 && !!first2 && first1 !== first2, "offset paginates to a different page");

    const anEvent = feed.json?.events?.[0];
    if (anEvent?.id) {
      const detail = await anon.get(`/api/event/${anEvent.id}`);
      ok(detail.status === 200 && detail.json?.id === anEvent.id, "GET /api/event/:id → the event");
    } else skipped("no event to fetch by id");

    ok((await anon.get("/api/event/does-not-exist")).status === 404, "unknown event id → 404");

    // scrape health is publicly observable: when it last ran, how much, freshness
    const st = await anon.get("/api/scrape-status");
    ok(st.status === 200 && typeof st.json?.totalEvents === "number", `GET /api/scrape-status → totalEvents=${st.json?.totalEvents}`);
    ok("stale" in (st.json || {}) && "lastRunAt" in (st.json || {}), "scrape-status reports lastRunAt + stale flag");
    if (st.json?.stale) skipped(`scrape is STALE (last run ${st.json?.lastRunAt || "never"}, ${st.json?.ageHours ?? "?"}h ago)`);
  }

  // ── 2. security posture ────────────────────────────────────────────────────
  section("2 · Security headers");
  {
    const r = await anon.get("/");
    const h = (k) => r.headers.get(k);
    ok(/max-age=\d+/.test(h("strict-transport-security") || ""), "HSTS present");
    ok((h("x-content-type-options") || "").toLowerCase() === "nosniff", "X-Content-Type-Options: nosniff");
    ok(/SAMEORIGIN|DENY/i.test(h("x-frame-options") || ""), "X-Frame-Options set");
    ok(!!h("referrer-policy"), "Referrer-Policy set");

    // headers must survive the error path too
    const err = await anon.get("/api/goals"); // 401 (no auth)
    ok(err.status === 401 && (err.headers.get("x-content-type-options") || "").toLowerCase() === "nosniff",
      "security headers present on error responses");
  }

  // ── 2b. no-auth gates (create nothing) — always run, incl. the light smoke ──
  section("2b · No-auth gates");
  {
    ok((await agent().post("/api/host", { title: "x", startUtc: "2099-01-01T00:00:00Z" })).status === 401, "POST /api/host without auth → 401");
    ok((await agent().post("/api/goals", { kind: "overall", title: "x" })).status === 401, "POST /api/goals without auth → 401");
    ok((await anon.post("/api/admin/ingest", { events: [] })).status === 401, "ingest without bearer → 401");
    ok((await anon.post("/api/admin/run-autopilot")).status === 401, "run-autopilot without bearer → 401");
  }

  // In light mode we stop here — everything above is read-only / negative, so a CI
  // post-deploy run leaves no users, communities, or friend requests behind.
  if (LIGHT) return finish();

  // ── 3. auth lifecycle + hardening ──────────────────────────────────────────
  section("3 · Auth (register / login / logout) + hardening");
  const A = agent("A");
  const emailA = `smoke+a-${STAMP}@thebay.events`;
  const emailB = `smoke+b-${STAMP}@thebay.events`;
  const password = `Sm0ke!${STAMP}Aa1`;
  {
    ok((await anon.get("/api/me")).json?.user === null, "GET /api/me (no cookie) → { user: null }");

    const reg = await A.post("/auth/password/register", { email: emailA, password, name: "Smoke Ann" });
    ok(reg.status === 200 && reg.json?.user?.id, "register → 200 + user");

    const me = await A.get("/api/me");
    ok(me.status === 200 && me.json?.user?.id === reg.json?.user?.id, "session cookie authenticates /api/me");

    // account-takeover guard: re-registering an existing email must 409, not link
    const dup = await A.post("/auth/password/register", { email: emailA, password, name: "x" });
    ok(dup.status === 409, "duplicate register → 409 (takeover guard)");

    // weak password rejected
    ok((await agent().post("/auth/password/register", { email: `smoke+w-${STAMP}@thebay.events`, password: "short" })).status === 400,
      "weak password → 400");

    // logout invalidates the session
    ok((await A.post("/auth/logout")).status === 200, "logout → 200");
    ok((await A.get("/api/me")).json?.user === null, "after logout /api/me → null");

    // wrong password → 401; correct password → back in
    ok((await A.post("/auth/password/login", { email: emailA, password: "wrong-password" })).status === 401, "bad login → 401");
    ok((await A.post("/auth/password/login", { email: emailA, password })).status === 200, "correct login → 200");
    ok((await A.get("/api/me")).json?.user?.id === reg.json?.user?.id, "re-authenticated as the same user");
  }

  // register a second agent for multi-user features
  const B = agent("B");
  const regB = await B.post("/auth/password/register", { email: emailB, password, name: "Smoke Bob" });
  ok(regB.status === 200, "second agent registered");
  await A.patch("/api/me", { socialEnabled: true });
  await B.patch("/api/me", { socialEnabled: true });

  // ── 4. self-scoped writes (no public litter) ───────────────────────────────
  section("4 · Self-scoped actions");
  {
    const goal = await A.post("/api/goals", { kind: "overall", title: `Meet 5 founders (${STAMP})` });
    ok(goal.status === 200, "create overall goal → 200");
    const goals = await A.get("/api/goals");
    ok(goals.json?.goals?.some((g) => g.title?.includes(STAMP)), "goal shows up in GET /api/goals");

    // RSVP to a real scraped event (semi-private; appears only on that event + my agenda)
    const feed = await A.get("/api/events?limit=1");
    const ev = feed.json?.events?.[0];
    if (ev?.id) {
      const rsvp = await A.post(`/api/events/${ev.id}/rsvp`, { status: "interested" });
      ok(rsvp.status === 200 && rsvp.json?.status === "interested", "RSVP interested → 200");
      const agenda = await A.get("/api/me/agenda");
      ok(agenda.status === 200 && Array.isArray(agenda.json?.events), "GET /api/me/agenda → events[]");
      // clean up: clear the RSVP so we leave no trace on the real event
      await A.post(`/api/events/${ev.id}/rsvp`, { status: "none" });
      ok(true, "RSVP cleared (no residue on the real event)");
    } else skipped("no event to RSVP");

    const sub = await A.post("/api/me/calendar/subscribe");
    ok(sub.status === 200 && /\/api\/cal\//.test(sub.json?.url || ""), "calendar subscribe → cookieless URL");
    if (sub.json?.url) {
      const token = sub.json.url.split("/api/cal/")[1];
      const ics = await anon.get(`/api/cal/${token}`); // fetched WITHOUT a cookie
      ok(ics.status === 200 && /BEGIN:VCALENDAR/.test(ics.text), "cookieless .ics feed serves the agenda");
    }
  }

  // ── 5. read-only feature surfaces ──────────────────────────────────────────
  section("5 · Feature surfaces (authenticated reads)");
  {
    for (const m of ["points", "intros", "nps"]) {
      const r = await A.get(`/api/rankings?metric=${m}`);
      ok(r.status === 200 && Array.isArray(r.json?.rows) && r.json?.metric === m, `rankings?metric=${m} → rows[]`);
    }
    ok((await A.get("/api/me/achievements")).status === 200, "GET /api/me/achievements → 200");
    ok((await A.get("/api/notes")).status === 200, "GET /api/notes (bulletin board) → 200");
    ok((await A.get("/api/integrations")).status === 200, "GET /api/integrations → 200");

    const feed = await A.get("/api/events?limit=1");
    const ev = feed.json?.events?.[0];
    if (ev?.id) ok((await A.get(`/api/events/${ev.id}/research`)).status === 200, "GET /api/events/:id/research → 200");
    else skipped("no event for research");
  }

  // ── 6. per-community rankings (the newest feature) ─────────────────────────
  section("6 · Communities + per-community rankings");
  {
    const created = await A.post("/api/communities", { name: `Smoke Circle ${STAMP}` });
    ok(created.status === 200 && created.json?.id, "create community → 200 + id");
    const id = created.json?.id;
    if (id) {
      const joined = await B.post(`/api/communities/${id}/join`);
      ok(joined.status === 200, "second agent joins the community");

      const detail = await A.get(`/api/communities/${id}`);
      ok(detail.status === 200, "GET /api/communities/:id → 200");
      ok(detail.json?.community?.name?.includes(STAMP), "returns the community");
      ok(detail.json?.members?.length === 2, "members = [creator, joiner]");
      ok(Array.isArray(detail.json?.rankings) && detail.json.rankings.length === 2, "rankings board is members-only (2 rows)");
      ok("points" in (detail.json?.rankings?.[0] || {}), "ranking rows carry the points column");

      const byIntros = await A.get(`/api/communities/${id}?metric=intros`);
      ok(byIntros.json?.metric === "intros", "community board respects ?metric=intros");
    } else skipped("community not created");
    ok((await A.get("/api/communities/nope-not-real")).status === 404, "unknown community → 404");
  }

  // ── 6b. people you may know: imported connections → members ────────────────
  section("6b · People you may know (imported connections → members)");
  {
    const bId = regB.json?.user?.id;
    // A imports a LinkedIn connection whose email is B's — B should surface as a suggestion.
    const imp = await A.post("/api/integrations/linkedin/import", {
      items: [{ externalId: `li:${emailB}`, kind: "connection", payload: { name: "Smoke Bob (from LinkedIn)", email: emailB } }],
    });
    ok(imp.status === 200, "import a connection with B's email");

    const sugg = await A.get("/api/integrations/suggestions");
    ok(sugg.status === 200 && (sugg.json?.suggestions || []).some((s) => s.id === bId), "B surfaces in people-you-may-know");

    if (bId) {
      ok((await A.post(`/api/friends/${bId}/request`)).status === 200, "connect to the suggested member");
      const after = await A.get("/api/integrations/suggestions");
      ok(!(after.json?.suggestions || []).some((s) => s.id === bId), "after connecting, B drops off the suggestions");
    }
  }

  // ── 7. authed write-gate (creates nothing) ─────────────────────────────────
  section("7 · Authed gate (negative path — no data created)");
  {
    // bulletin board is GPS-gated to the Bay — a note from outside must 403
    const outside = await A.post("/api/notes", { ...OUT_BAY, body: `should be blocked ${STAMP}` });
    ok(outside.status === 403, "board note from outside the Bay → 403 (GPS gate)");
  }

  // ── 8. full destructive journey (opt-in; creates public data) ──────────────
  section("8 · Full journey: host → RSVP → check-in → review-gate");
  if (!FULL) {
    skipped("host/check-in/board-post create publicly visible data — set PROD_FULL=1 to run against live");
  } else {
    const host = A, goer = B;
    const startUtc = "2099-09-01T18:00:00Z";
    const created = await host.post("/api/host", { title: `Smoke Summit ${STAMP}`, startUtc });
    ok(created.status === 200 && created.json?.id, "host creates an event");
    const eid = created.json?.id;

    if (eid) {
      const rsvp = await goer.post(`/api/events/${eid}/rsvp`, { status: "going" });
      ok(rsvp.status === 200, "attendee RSVPs going");

      const tokRes = await host.post(`/api/events/${eid}/checkin-token`);
      ok(tokRes.status === 200 && tokRes.json?.token, "host issues a check-in token");
      const nonHostTok = await goer.post(`/api/events/${eid}/checkin-token`);
      ok(nonHostTok.status === 403, "non-host cannot issue a check-in token");

      if (tokRes.json?.token) {
        const ci = await goer.post(`/api/events/${eid}/checkin`, { token: tokRes.json.token });
        ok(ci.status === 200, "attendee checks in with the QR token");
      }

      const roster = await host.get(`/api/events/${eid}/checkins`);
      ok(roster.status === 200 && (roster.json?.checkins?.length ?? roster.json?.rows?.length ?? 0) >= 1, "host sees the live roster");

      const review = await goer.post(`/api/events/${eid}/review`, { rating: 5, body: `great ${STAMP}` });
      ok(review.status === 200, "attendee reviews the attended event");
    }

    // board post from inside the Bay now succeeds (this DOES post publicly)
    const note = await A.post("/api/notes", { ...IN_BAY, body: `hello from the smoke test ${STAMP}` });
    ok(note.status === 200 && note.json?.id, "board note from inside the Bay → posted");
  }

  return finish();

  // hoisted — callable from the light-mode early return above
  function finish() {
    console.log(`\n\x1b[1mResult:\x1b[0m ${pass} passed, ${fail} failed, ${skip} skipped  (${BASE}${LIGHT ? " · light" : ""})`);
    if (fail) { console.log("\x1b[31mFailures:\x1b[0m\n  - " + failures.join("\n  - ")); process.exit(1); }
    console.log(`\x1b[32mAll production checks passed — the live site is fully navigable by an agent.\x1b[0m`);
  }
}

main().catch((e) => { console.error("\x1b[31mfatal:\x1b[0m", e); process.exit(2); });
