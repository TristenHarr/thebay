# The Bay — Platform Specification

> The world's best social platform for **founders × events**. Discover events, show up
> with intent, capture the moment, review honestly, and turn attendance into
> relationships — introductions, mentors, co-founders — on autopilot.
>
> **Status:** living spec. Built test-first on the existing Cloudflare backend
> (Worker + D1 + Durable Objects + R2/KV), which is already live at `thebay.events`.
> Nothing here rebuilds working backend logic; it extends it. The frontend is
> re-platformed to a proper typed React app.
>
> **Build status — ALL 33 planned tasks complete + audited.** Backend + web
> TypeScript compile clean; **116 unit + HTTP-route-integration tests** and a
> **27-check Playwright navigation matrix** pass with zero page errors. A three-way
> adversarial audit (backend SQL/route/authz, frontend↔backend contract, test-coverage)
> found and fixed real defects: an ungated review endpoint (fake-review/points farming),
> unbounded photo-point farming, cross-user media tagging, unscoped push-unsubscribe,
> forge-able intro forwards, and FK-violation 500s → clean 404/409. The warm-intro
> flow was completed end-to-end (a forwarded intro can now be accepted; you can
> request an intro from a profile). Each fix ships with a regression test. Shipped: goals/achievements/streaks + public sharing,
> world's-best faceted Discover + trip planner, structured itinerary + calendar sync,
> Luma/Eventbrite/Meetup/Calendar (ICS) + LinkedIn CSV + Telegram integrations,
> QR check-in (attendee scan + host door + live roster), review-gate, media
> timeline (photos/video, geo/time), warm intros, mentors/co-mentoring, co-founder
> matching, communities + rankings, **interactive network graph** (canvas force sim),
> **AI event deep-research** + **AI networking agent** (approve-each), **⌘K command
> palette** (keyboard-first), **installable PWA** (offline SW + web push/VAPID),
> and a **Capacitor** wrap scaffold. Cloudflare Access OTP login is wired + verified
> (JWT verify, 7 tests); the dashboard provisioning steps are in `DEPLOY.md`.

---

## 0. Guiding principles

1. **Simple beats complete-looking.** Every screen earns its place in the nav map (§3). If it's not in the IA, it isn't built. No clutter.
2. **Type-safe end to end.** zod schemas in `shared/` are the contract; the Worker validates against them and the React app derives its types + RTK Query endpoints from them. Malformed data can't reach a handler or a component.
3. **Test-first.** No feature merges without (a) unit tests for its rules and (b) a Playwright navigation test proving its screen renders and its golden path works.
4. **Invariants in the schema.** FK / CHECK / UNIQUE encode the rules (review-gate, one-review-per-subject, idempotent points) so the DB refuses bad states.
5. **Cloudflare-native.** Access for login, Images/Stream for media, D1/DO/R2/KV for data. One region of concepts.
6. **Web and mobile from one codebase.** Installable PWA first; Capacitor wrap later. No parallel apps.
7. **Refined-professional design.** Credible to a founder/VC audience; gamification is a small celebratory accent, never the theme.

---

## 1. Personas & golden journeys

| Persona | Wants | Golden path |
|---|---|---|
| **Attendee (founder)** | Find the right rooms, show up with a goal, meet the right people | discover → set event goal → RSVP → check in (QR) → capture photo → **review (required)** → get intro'd |
| **Host / Organizer** | Run great events, know who's coming, follow up | create event → invite → check-in dashboard → collect reviews → see attendee graph |
| **Connector / Mentor** | Give & get intros, mentor, rank up | set mentor profile → accept requests → make intros → climb community rankings (super-connector) |

**North-star journey (must always work):** *Sign in → set an overall goal → discover an event → set an event goal → RSVP → (later) check in → post a photo → review it → receive a suggested intro that advances the goal.*

---

## 2. Auth — Cloudflare Access (email one-time-PIN)

- A **Cloudflare Access application** protects exactly one path: `GET /auth/access/login`. Everything else (browse, API reads) stays public.
- Flow: user taps **Sign in** → hits `/auth/access/login` → Cloudflare shows its own **email one-time-PIN** screen (CF sends a 6-digit code; no Google console, no API keys) → on success Cloudflare forwards the request with a signed **`Cf-Access-Jwt-Assertion`** header.
- The Worker (`src/auth/access.ts`) verifies that JWT against the team's **JWKS** (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), extracts the verified `email`, calls `SocialRepo.upsertByIdentity({ provider: "access", providerUid: email, email, emailVerified: true })`, mints the existing **KV session cookie**, and redirects to `/app`.
- Google-through-Access is a later add: register a Google IdP in the Zero-Trust dashboard; no app-code change.
- **Invariants:** JWT `aud` must match the Access app AUD tag; `email` required; expired/invalid → 401. Anonymous users keep full read access; only writes require a session (existing `requireAuth`).

---

## 3. Information architecture & navigation map

Routes are the source of truth for the Playwright nav matrix (§11). `🔒` = requires session (redirects to sign-in), `◐` = public but richer when signed in.

```
/app                       Home / feed                         ◐
/app/discover              Search + filters + map toggle       ◐
/app/event/:id             Event detail                        ◐
/app/event/:id/checkin     QR check-in (scan or show code)     🔒
/app/event/:id/review      Quick review survey                 🔒 (gated)
/app/host                  Create / manage an event            🔒
/app/goals                 My goals (overall + per-event)      🔒
/app/achievements          Streaks, trophies, shareable        🔒
/app/u/:handle             Public profile (goals/achievements) ◐
/app/me                    My profile + settings + integrations🔒
/app/friends               Friends + requests + import         🔒
/app/groups                Themed groups list                  🔒
/app/group/:id             Group chat + theme                  🔒
/app/intros                Intros inbox / on-autopilot          🔒
/app/mentors               Find / request mentors               🔒
/app/match                 People / co-founder matching         🔒
/app/communities           Communities + rankings              ◐
/app/community/:id         Community detail + leaderboard      ◐
/app/leaderboard           Global / friends rankings           ◐
/app/media                 My photos & videos timeline         🔒
/app/agent                 AI networking agent settings (P4)   🔒
```

**Primary nav (bottom bar on mobile, sidebar on web):** Home · Discover · Goals · Network · Me.
"Network" is a hub → Friends / Groups / Intros / Mentors / Match / Communities. Keeping the top-level nav to **5** items is a hard rule (anti-clutter).

---

## 4. Design system (refined professional)

### Tokens (CSS variables; Tailwind reads them)
- **Neutral (slightly cool):** `--bg #0b0e13` / `--surface #141a22` / `--elev #1b232e` / `--border #263041` / `--text #eef2f7` / `--muted #8a95a5`. Light theme mirrors with the same ramp inverted.
- **Accent (one, confident):** `--accent #4f7cff` (indigo-blue) + `--accent-ink`. Used for primary actions and focus only.
- **Semantic (separate from accent):** `--ok #37b980`, `--warn #e8a33d`, `--crit #e5484d`.
- **Celebratory (achievements only):** `--gold #f5c451` for streaks/badges — the *only* place vibrant color appears.
- **Radius** `10/14/999`; **shadow** soft, low-contrast; **space** on a 4px scale.

### Type
- **Display:** a characterful grotesk (e.g. "Space Grotesk"/"General Sans"), inlined as `@font-face` data-URI — headings, balanced (`text-wrap: balance`).
- **Body:** a clean humanist sans (system stack fallback). Type scale `12 / 14 / 16 / 20 / 26 / 34`. Running text ≤ 68ch.
- **Numeric:** `tabular-nums` wherever figures align (rankings, streaks, counts).

### Components (Radix primitives + Tailwind)
`Button` (primary/ghost/quiet), `Card`, `Avatar` (image/initials), `Chip/Badge`, `Tabs`, `Dialog`, `Sheet` (mobile bottom-sheet), `Field` (label+input+error), `SegmentedControl`, `Stat`, `Streak`, `EmptyState`, `Toast`, `PillNav`. Every interactive element has a visible focus ring and works with keyboard.

### Rules
- Mobile-first; the same components reflow (bottom-sheet on mobile ↔ dialog on desktop).
- Light **and** dark, token-driven; both audited for contrast.
- Motion is subtle and respects `prefers-reduced-motion`.
- Gamification (streaks, trophies, "super-connector") appears as small gold accents and on `/app/achievements` — never on the core event/networking surfaces.

*(Authored with the `artifact-design` skill; visual snapshots become Playwright baselines.)*

---

## 5. Feature specifications

Each feature: **Purpose · Rules/invariants · Acceptance criteria (AC)**. Grouped by phase.

### Phase 0 — Foundation (parity migration)
Re-implement existing features on the new stack with identical behavior: **Feed, Discover+Map, Event detail, Friends, Groups+chat, Leaderboard, Host, Profile, Avatar**. AC: the existing 17 app behaviors pass as Playwright tests on the React app; CF Access OTP sign-in works; classic dashboard untouched.

### Phase 1a — Goals & Achievements
**Goals.** Purpose: attend with intent.
- **Overall goals** (e.g. "Raise a seed round", "Find a technical co-founder") and **per-event goals** (attached at RSVP: "meet 3 fintech founders").
- Rules: a goal has `title`, optional `metric/target`, `status` (`active|done|archived`), visibility (`private|friends|public`). Per-event goal links `user × event`.
- AC: create/edit/complete a goal; attach a goal when RSVPing; `/app/goals` lists both; public goals render on `/app/u/:handle` when visibility=public.

**Achievements / streaks / trophies.** Purpose: reward showing up + connecting.
- Server-awarded only (extends `points_ledger`): attend-streak (consecutive weeks with ≥1 check-in), "first review", "5 intros made", "super-connector" (top decile by intros), etc.
- Rules: each achievement idempotent via a `dedup_key`; streaks computed from `checkins`.
- AC: streak increments on check-in and resets after a gap; `/app/achievements` shows earned + progress; a trophy is shareable to `/app/u/:handle`.

**Community rankings.** `/app/leaderboard` + `/app/community/:id`: rank by points, **intros made**, NPS. "Super-connector" badge = top by intros in a community. AC: rankings sort correctly; friend-scoped toggle; badge shown on qualifying profiles.

### Phase 1b — Integrations
Realistic mechanisms, each behind a per-user `integration_accounts` row.
- **Luma:** import events you've RSVP'd + co-attendees (Luma API where a key exists, else your Luma calendar `.ics`). AC: imported events appear as `imported_items` and can be added to your itinerary.
- **Eventbrite / Meetup:** import via public event pages / user `.ics`. AC: at least event import works, deduped against scraped events by fingerprint.
- **Calendar (key feature — plan & schedule):** (1) subscribe to your RSVPs as a live **ICS feed** (`/api/me/calendar.ics`); (2) **add-to-calendar** per event (Google/Apple/Outlook links); (3) a **plan/schedule** view that lays your RSVPs + itinerary on a week grid with travel gaps. AC: ICS validates in Google/Apple; plan view shows conflicts.
- **LinkedIn:** import connections via LinkedIn's **data-export CSV** (no connections API); optionally paste/import a feed. AC: CSV upload maps to suggested friends/mentors.
- **Telegram:** link a **Telegram bot** so a group's chat can mirror to Telegram and friends can be matched by handle. AC: linking round-trips a code; a group message can post to the linked Telegram chat.

### Phase 2 — Event experience
**Reviews (quick survey + mandatory gate).**
- Subjects: `event | host | speaker | participant`. Survey ≤ 4 taps: overall (1–5), one tag chip set (e.g. "great talks / good networking / worth it"), optional one-line note, optional NPS.
- **Review-gate invariant:** if you have any **unreviewed attended** event (`checkins` exists and event is past), you **cannot RSVP** to a new event until you review it. Enforced server-side via `review_obligations`; the UI routes you to `/app/event/:id/review`.
- AC: attending creates an obligation; RSVP blocked with a clear prompt until satisfied; one review per (subject_type, subject_id, user).

**QR check-in.** Each event has rotating `checkin_tokens`; attendee scans the host's QR (or shows their own for the host to scan). AC: scanning a valid token creates a `checkin`, awards points, starts/continues the streak, opens the review obligation; invalid/expired token rejected.

**Photos + videos (social feed).** Cloudflare **Images** (photos) + **Stream** (video); R2 keeps originals. EXIF `lat/lng` + `taken_at` captured → **geo/time-fenced** suggestion ("These 4 photos look like they're from *Founders Gathering* — attach?"). Tag people (friends). AC: upload photo & video; media shows on the event + on `/app/media` timeline; geo/time suggestion offered; tags notify the tagged.

**Structured itinerary.** Multi-slot day plan (destination / eat / leisure / transport) built from RSVPs; reuses existing travel-gap logic. AC: build a day, see travel warnings, export to calendar.

**Conference tools (light):** an event can have sessions/speakers; host sees a live check-in count. AC: add sessions + speakers; check-in count updates.

### Phase 3 — Founder graph
**Friends + themed groups.** Friends (existing) + friend **import** (Phase 1b). Groups gain a **theme** (color + tag, e.g. "AI infra", "Climbing + code"). AC: create a themed group; theme shows in list & chat header; chat is the existing DO.

**Warm intros on autopilot.** The Intros.com pattern:
- Request: "intro me to *X*" or "who can intro me to *Sequoia*?" → the graph finds friends-of-friends / community overlap.
- Forwardable: a connector reviews and forwards a blurb; when both accept, they're connected + it's logged (points, "intro made").
- AC: create an intro request; a connector sees it in `/app/intros`, forwards; acceptance connects both and increments intro counts + rankings.

**Mentors.** `mentor_profiles` (topics, availability) + `mentor_requests` (pending/accepted). Mentor **programs** = a community with a mentor track. AC: set a mentor profile; request a mentor; accept/decline; connected mentors appear in your network.

**Matching (people / co-founder).** Rich profile (idea? technical? commitment, location radius, interests) + filters; a swipe-style **invite / save / skip / hide** deck (YC co-founder-matching pattern). Mutual invite = a match → chat. AC: set match prefs; the deck respects filters; a mutual invite creates a match + opens chat.

### Phase 4 — AI flavors (last)
- **Event deep-research:** "who's coming, who's speaking, who's VIP, what's in it for *me*?" — an agent summarizes the attendee/speaker graph vs. your goals. AC: returns a grounded, cited briefing for an event.
- **AI networking agent (toggle):** with consent + guardrails, drafts intro requests/forwardables and suggests matches that advance your goals; you approve each action. AC: toggling on produces *suggested* (never auto-sent) actions with clear provenance.

### Phase 5 — Native mobile
Capacitor wrap of the PWA (iOS/Android) + push notifications (intro received, review due, friend checked in nearby). AC: installable build; a push arrives for "review due".

---

## 6. Data model (D1)

Existing (from `migrations/0001_init.sql`): `users, identities, magic_links, sources, events, event_sources, rsvps, friendships, groups, group_members, messages, event_photos, reviews, points_ledger, geocode_cache, runs, run_source_results`. **New migrations `0002+`:**

```
goals(id, user_id→users, title, kind CHECK(overall|event), event_id→events NULL,
      metric, target, progress, status CHECK(active|done|archived),
      visibility CHECK(private|friends|public), created_at, updated_at)
achievements(id, user_id, kind, dedup_key UNIQUE, awarded_at, meta_json)
streaks(user_id PK, kind, count, best, last_at)
reviews  -- ALTER: add subject_type CHECK(event|host|speaker|participant), subject_id
review_obligations(user_id, event_id, created_at, satisfied INT DEFAULT 0,
      PRIMARY KEY(user_id,event_id))                      -- the review-gate
checkin_tokens(id, event_id→events, token UNIQUE, expires_at)
checkins(user_id, event_id, at, source CHECK(qr|manual), PRIMARY KEY(user_id,event_id))
media(id, user_id, event_id→events NULL, kind CHECK(photo|video),
      image_id, stream_id, r2_key, lat, lng, taken_at, caption, created_at)
media_tags(media_id→media, user_id→users, PRIMARY KEY(media_id,user_id))
intro_requests(id, requester_id, target_desc, target_user_id NULL, status, created_at)
intro_forwards(id, request_id→intro_requests, connector_id, status
      CHECK(offered|forwarded|accepted|declined), created_at)
mentor_profiles(user_id PK, topics_json, availability, blurb, active INT)
mentor_requests(id, mentee_id, mentor_id, status CHECK(pending|accepted|declined), created_at)
match_prefs(user_id PK, has_idea INT, technical INT, commitment, radius_km, interests_json)
match_actions(actor_id, target_id, action CHECK(invite|save|skip|hide),
      PRIMARY KEY(actor_id,target_id))                    -- mutual invite ⇒ match
communities(id, name, kind, created_by, created_at)
community_members(community_id, user_id, role, joined_at, PRIMARY KEY(community_id,user_id))
groups -- ALTER: add theme, theme_color
integration_accounts(user_id, provider CHECK(luma|eventbrite|meetup|calendar|linkedin|telegram),
      token_json, connected_at, PRIMARY KEY(user_id,provider))
imported_items(id, user_id, provider, external_id, kind, payload_json, created_at,
      UNIQUE(user_id,provider,external_id))
agent_settings(user_id PK, networking_enabled INT DEFAULT 0, guardrails_json, updated_at)
```
Every child FK `ON DELETE CASCADE`; every "one per pair" is a composite PK; points/achievements idempotent via UNIQUE `dedup_key`.

---

## 7. API surface (Worker, Hono)

Additive `/api/*`, CORS-open for reads, `requireAuth` for writes. Representative routes:
- Goals: `GET/POST/PATCH /api/goals`, `POST /api/events/:id/goal`.
- Achievements: `GET /api/me/achievements`, `GET /api/leaderboard?scope&metric`.
- Reviews: `GET /api/me/obligations`, `POST /api/events/:id/reviews` (subject-typed), and RSVP returns `403 review_required` when a gate is open.
- Check-in: `POST /api/events/:id/checkin {token}`, host `GET /api/events/:id/checkins`.
- Media: `POST /api/media` (direct-creator-upload URLs for Images/Stream) → `PATCH /api/media/:id` (geo/tags), `GET /api/me/media`.
- Intros: `POST /api/intros`, `GET /api/intros`, `POST /api/intros/:id/forward`, `POST /api/intros/:id/respond`.
- Mentors: `GET/POST /api/mentors`, `POST /api/mentors/:id/request`, `POST /api/mentor-requests/:id/respond`.
- Match: `GET /api/match/deck`, `POST /api/match/:userId {action}`, `GET/PUT /api/match/prefs`.
- Communities: `GET /api/communities`, `GET /api/communities/:id`, `POST /api/communities/:id/join`.
- Integrations: `POST /api/integrations/:provider/connect`, `POST /api/integrations/:provider/import`, `GET /api/me/calendar.ics`.
- Auth: `GET /auth/access/login` (Access-protected) + existing `/auth/logout`.
All bodies/responses validated by `shared/schema.ts`; RTK Query endpoints generated from the same types.

---

## 8. Non-functional
- **Performance:** app JS ≤ ~200KB gzip initial (route-split; Stream/Images do the heavy media); LCP < 2.5s on 4G.
- **Privacy/consent:** social + AI networking are opt-in; imports show exactly what's pulled; tagging notifies; every public surface honors `visibility`.
- **Moderation:** report + hide on media/reviews/messages; rate limits on writes.
- **Offline/PWA:** cached app shell + last feed; queue a review/check-in offline, sync on reconnect.
- **Accessibility:** Radix semantics, focus management, contrast in both themes.

---

## 9. Test matrix (TDD)

**Unit (Vitest, `tests/*.test.ts`), written first** — reuse `tests/helpers/d1.ts`:
- review-gate: attend → obligation blocks RSVP → review clears it.
- points/achievements idempotency; streak increment/reset.
- intro forwarding state machine; mutual-invite ⇒ match; ranking sort.
- goal visibility filtering; calendar ICS validity; import dedup.

**E2E (Playwright, `tests/e2e/*`) — one nav test per route in §3** (renders; guarded routes redirect anon → sign-in) plus **golden-journey** tests:
- sign-in (Access OTP mocked) → set goal → RSVP with event-goal → check-in (QR) → upload photo → review → RSVP-again succeeds.
- friend request/accept → themed group → live chat message (DO WS).
- create intro request → connector forwards → both accept → rankings update.
- matching deck respects filters → mutual invite → chat opens.
- **Visual snapshots** for: Home, Event detail, Goals, Achievements, Profile, Match deck (light + dark).
- Regression guard: existing **classic dashboard e2e stays green**.

---

## 10. Phased roadmap (exit criteria)

| Phase | Ships | Exit criteria |
|---|---|---|
| **0** Foundation | React/TS/Vite/Tailwind/RTK app, design system, **CF Access OTP**, parity migration | Access login works; all §3 routes have green nav tests; classic site unbroken |
| **1a** Goals/Achievements | goals (overall+event), streaks/trophies, public share, rankings | goal + review-gate-independent AC green; leaderboard ranks |
| **1b** Integrations | Luma/Eventbrite/Meetup import, Calendar sync+plan, LinkedIn, Telegram | ICS validates; ≥1 import path per provider green |
| **2** Event experience | review-gate, quick reviews, QR check-in, photos+videos, itinerary, conf tools | review-gate + check-in + media journeys green |
| **3** Founder graph | friends/themed groups, intros autopilot, mentors, matching, communities | intro + match journeys green; rankings update |
| **4** AI flavors | event deep-research, AI networking agent (approve-each) | grounded briefing; suggestions never auto-send |
| **5** Native | Capacitor iOS/Android + push | installable build; a "review due" push arrives |

---

## 12. Addenda (evolving requirements)

- **Built for nerds & computer scientists.** The design carries a deliberate CS flavor within the refined-professional frame: **monospace** for data/counts/IDs, a **⌘K command palette** + keyboard shortcuts everywhere, dense-but-legible tables, dark-mode default, and precise, jargon-comfortable copy. Power, not noise.
- **World's-best filtering + trip planner — carried over.** `/app/discover` must reproduce the classic dashboard's faceted filtering (date window, time-of-day, category, city, source, min-interest, free, curated, full-text) with **live counts**, plus the **trip planner** and **structured itinerary** with travel-gap warnings. This is a first-class surface, not a port afterthought — it must feel perfect and fast.
- **Founder / network graph visualization** (`/app/network`): an interactive force-directed graph of you ↔ friends ↔ intros ↔ communities that surfaces **paths to a target** ("who can intro me to X"). It powers the intros feature visually and is a signature nerd-delight surface.
- **Co-mentoring:** mentorship is not strictly one-directional — two people can mentor each other (peers). An accepted mentor request connects both symmetrically; the mentors UI exposes "offer to co-mentor."

## 13. Definition of done (every feature)
1. zod schema in `shared/`. 2. Migration (if data). 3. Repo method + **unit test first**. 4. Worker route (validated). 5. RTK Query endpoint. 6. UI in `web/src/features/<f>/` using the design system. 7. **Playwright nav test** + journey test. 8. It's in the §3 nav map. 9. Deployed; classic site still green.
