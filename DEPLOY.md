# The Bay — deploy & provisioning

**LIVE at https://thebay.events.** Deployed, migrated (0001–0004), and smoke-tested.
**Login works today** via self-contained email + password (no external provider).
The sections below are optional add-ons; each degrades gracefully until configured.

## 0. Build & deploy

```bash
export CLOUDFLARE_ACCOUNT_ID=571af6c05aec7513477b528a6615559b   # two accounts on this login
npm run build-site && npm run build-web        # classic site + React app → dist/site
npx wrangler d1 migrations apply thebay-db --remote   # 0001–0004 (tracked; applies only new)
npx wrangler deploy
```

## 1. Login — email + password (LIVE, zero setup)   ← what's running now

Self-contained: PBKDF2 (`src/auth/password.ts`, 4 tests) + `password_credentials`
(migration 0004) + KV sessions. Routes `POST /auth/password/{register,login}`
(integration-tested). The `SignIn` screen is a register/login form — nothing to
provision. Limitation without an email provider: no email verification or password
reset yet (add when §3-style email is configured).

## 1b. Login — Cloudflare Access (optional, adds passwordless OTP)

The Worker also verifies Cloudflare's signed identity JWT (`src/auth/access.ts`, 7 tests).
To add it alongside password login:

1. **Zero Trust → Access → Applications → Add → Self-hosted.**
2. Application domain: `thebay.events`, path: `/auth/access/login`.
3. Identity: enable **One-time PIN** (email code). Add a policy: *Allow — Emails ending in* (or *Everyone*).
4. After creating it, copy the application's **AUD** tag and your **team domain**
   (`your-team.cloudflareaccess.com`), then set them as secrets:

```bash
npx wrangler secret put ACCESS_AUD           # paste the Application Audience (AUD) tag
npx wrangler secret put ACCESS_TEAM_DOMAIN   # e.g. your-team.cloudflareaccess.com
```

The `SignIn` screen's **"Continue with email"** button already points at
`/auth/access/login`; once the secrets exist, Cloudflare emails the code, forwards
the signed request, the Worker verifies it and starts the session. Done.

## 2. Web push (VAPID) — notifications

```bash
npx web-push generate-vapid-keys      # prints a public + private key
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT   # mailto:hello@thebay.events
```

`GET /api/push/key` then returns `enabled:true`, the "Enable notifications" opt-in
appears (Agent screen), and `src/push/webpush.ts` (3 tests) signs the pushes.

## 3. Media — Cloudflare Images / Stream (photos + video)

Photos already work via R2 (`PHOTOS` bucket). For video and Images variants:

```bash
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put STREAM_TOKEN     # API token with Stream:Edit
npx wrangler secret put IMAGES_TOKEN     # API token with Images:Edit
```

## 4. Workers AI — brief/agent phrasing (optional)

Bound in `wrangler.jsonc` (`"ai": { "binding": "AI" }`). No secret needed; it just
works on deploy. The AI brief and networking agent already produce their full
deterministic output without it — AI only rephrases the prose.

## 4b. The scrape network — REQUIRED for volunteer scraping

Two settings, and the network is completely inert without them. Both fail silently in
different ways, so set them before wondering why nothing works.

```bash
# HMAC key for the animated in-person handshake. Frame codes derive from it and are never
# stored, so rotating it only kills the sessions currently on screen (they live 30s).
openssl rand -base64 32 | npx wrangler secret put HANDSHAKE_KEY

# Founding members. Only trusted/core members can vouch for someone, and network_members
# starts EMPTY — so without at least one handle here, nobody can ever be admitted and the
# first handshake 403s forever. The cron seeds these handles as `core` once they sign in.
npx wrangler secret put ADMIN_HANDLES     # e.g. ann,raj
```

Check both landed, and that the network is alive:

```bash
curl -s https://thebay.events/api/net/status | jq
# { "handshakeConfigured": true, "members": 1, "workers": 0,
#   "recipes": { "active": 22, ... }, "jobs": { "open": 22 }, "hosts": { "robotsChecked": 9 } }
```

`handshakeConfigured: false` means `HANDSHAKE_KEY` is missing — joining will 503.
`members: 0` after the named handles have signed in means the cron hasn't run yet (it is on
the 15-minute trigger, same as everything else).

**Then onboard a volunteer:** they sign in, you meet them, you open `/app/handshake` → Show,
they open it → Scan. They register a worker in `/app/contribute` and then either:

- **clone the repo** and run `BAY_WORKER_TOKEN=… npm run work -- --url https://thebay.events`
  (this package is `private: true`, so `npx thebay-worker` needs a publish first — `bin/thebay-worker.mjs`
  is the entry point when you're ready to make that call), or
- **load the Chrome extension**: `npm run build:extension`, then `chrome://extensions` →
  Developer mode → Load unpacked → `dist/extension`. A real browser on a real residential
  connection, which is the whole point — it gets the sources that refuse a datacenter IP.

Nothing about this hands out `INGEST_TOKEN`. Worker tokens reach `/api/net/*` only.

## 5. Native apps (Capacitor) — later phase

`capacitor.config.ts` targets the same `dist/site/app` build. When ready:

```bash
npm i -D @capacitor/cli && npm i @capacitor/core @capacitor/ios @capacitor/android @capacitor/push-notifications
npm run build-web
npx cap add ios && npx cap add android
npm run cap:sync
npm run cap:ios      # opens Xcode
```

## Tests

```bash
npm test              # 120 unit + HTTP-route integration tests (repos, routes, review-gate,
                      # security regressions, ICS full-field import, LinkedIn CSV, VAPID JWT, AI,
                      # filtering, access JWT)
npm run test:nav      # 29-check Playwright nav matrix (needs `wrangler dev` on :8787, DEV_LOGIN=1)
npm run new:feature <x>  # scaffold a wired, tested vertical slice — see ARCHITECTURE.md
```
