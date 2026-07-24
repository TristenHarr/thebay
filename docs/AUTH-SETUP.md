# Turning on sign-in (production)

The platform is deployed and working; the only thing that can't be done for you is
registering OAuth apps under *your* Google/GitHub accounts. Do any one of these and
sign-in goes live at `https://thebay.events/app`.

## Option A — Google (Gmail) sign-in
1. Go to https://console.cloud.google.com/apis/credentials → **Create Credentials → OAuth client ID → Web application**.
2. **Authorized redirect URI:** `https://thebay.events/auth/google/callback`
3. Copy the Client ID + Client secret, then:
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_ID       # paste the client id
   npx wrangler secret put GOOGLE_CLIENT_SECRET   # paste the secret
   ```

## Option B — GitHub sign-in
1. https://github.com/settings/developers → **New OAuth App**.
2. **Homepage URL:** `https://thebay.events` — **Authorization callback URL:** `https://thebay.events/auth/github/callback`
3. Copy the Client ID, generate a client secret, then:
   ```bash
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   ```

## Option C — Email magic link
Needs an email sender. Easiest is [Resend](https://resend.com) (free tier):
1. Verify the `thebay.events` domain in Resend (adds SPF/DKIM DNS records).
2. Create an API key, then:
   ```bash
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put EMAIL_FROM        # e.g. "The Bay <login@thebay.events>"
   ```

No redeploy needed — secrets take effect immediately. The sign-in buttons on
`/app` already point at these flows; unconfigured providers return a clean 503.

## Notes
- **Never** set `DEV_LOGIN=1` as a production secret — it would let anyone sign in as anyone. It lives only in local `.dev.vars` for testing.
- `INGEST_TOKEN` is already set (the local scraper uses it to push events + geocodes; the value is in local `.ingest-token`).
- Sessions are opaque tokens in the `SESSIONS` KV (30-day TTL), set as `HttpOnly; Secure; SameSite=Lax` cookies.
