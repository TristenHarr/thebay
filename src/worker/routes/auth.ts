import { Hono } from "hono";
import type { Env } from "../env";
import { SocialRepo } from "../../storage/d1/social-repo";
import { startSession, endSession, currentUserId } from "../../auth/session";
import { mintHandoff, claimHandoff, safeNextPath, isTopLevelNavigation } from "../../auth/handoff";
import { canonicalOrigin, newsOrigin } from "../origin";
import { authorizeUrl, completeOAuth, pkceChallenge, providerConfigured, randomString, type Provider } from "../../auth/oauth";
import { requestMagicLink, verifyMagicLink } from "../../auth/magic";
import { fetchAccessIdentity } from "../../auth/access";
import { hashPassword, verifyPassword, passwordProblem, DUMMY_HASH } from "../../auth/password";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const originOf = (c: { env: Env; req: { url: string } }) => c.env.PUBLIC_ORIGIN || new URL(c.req.url).origin;

/** The sibling site's origin, from wherever this request arrived. */
function siblingOrigin(c: { env: Env; req: { url: string } }): string {
  const host = new URL(c.req.url).host.toLowerCase();
  const news = newsOrigin(c.env);
  return host === new URL(news).host.toLowerCase() ? canonicalOrigin(c.env) : news;
}

export function authRoutes(): Hono<{ Bindings: Env }> {
  const a = new Hono<{ Bindings: Env }>();

  // ── cross-domain handoff ────────────────────────────────────────────────
  // thebay.events and thebay.news can't share a cookie (different registrable
  // domains), so a signed-in reader is handed across with a single-use token.
  // Mounted on BOTH Workers: /start mints for the sibling, /handoff claims here.
  // Call this on the origin you are LEAVING — it mints for the sibling and sends
  // you there. Linking to the *other* site's /start bounces you straight back.
  a.get("/auth/handoff/start", async (c) => {
    const target = siblingOrigin(c);
    const next = safeNextPath(c.req.query("next"));
    // localStorage can't span two registrable domains, so the reader's theme
    // rides along in the URL and the landing page's bootstrap script adopts it.
    const theme = c.req.query("theme");
    const themeQ = theme === "dark" || theme === "light" ? `theme=${theme}` : "";
    const withTheme = (url: string) =>
      themeQ ? url + (url.includes("?") ? "&" : "?") + themeQ : url;

    const uid = await currentUserId(c);
    // Not signed in: send them over anyway, logged out. Never emit an empty token.
    if (!uid) return c.redirect(withTheme(target + next), 302);
    const token = await mintHandoff(c.env, uid, new URL(target).host, next);
    return c.redirect(withTheme(`${target}/auth/handoff?t=${encodeURIComponent(token)}`), 302);
  });

  a.get("/auth/handoff", async (c) => {
    // Must be a real navigation — otherwise an <img> or fetch() could be used to
    // silently sign a victim in as the attacker.
    if (!isTopLevelNavigation(c.req.raw.headers)) return c.text("bad request", 400);
    const claim = await claimHandoff(c.env, c.req.query("t") || "", new URL(c.req.url).host);
    // Unknown, expired, used, or wrong host all look the same from outside.
    const theme = c.req.query("theme");
    const suffix = theme === "dark" || theme === "light" ? `?theme=${theme}` : "";
    if (!claim) return c.redirect("/" + suffix, 302);
    await endSession(c); // never merge into an existing session
    await startSession(c, claim.userId);
    // Token never persists in the URL bar; the theme does, just long enough for
    // the landing page's bootstrap to store it.
    const dest = claim.nextPath + (suffix && !claim.nextPath.includes("?") ? suffix : "");
    return c.redirect(dest, 302);
  });

  // ── OAuth (Google, GitHub) ──────────────────────────────────────────────
  a.get("/auth/:provider/start", async (c) => {
    const provider = c.req.param("provider");
    if (provider !== "google" && provider !== "github") return c.text("unknown provider", 404);
    if (!providerConfigured(provider, c.env)) return c.text(`${provider} sign-in isn't configured yet`, 503);
    const state = randomString(24);
    const verifier = randomString(48);
    await c.env.OAUTH_STATE.put(`oauth:${state}`, JSON.stringify({ provider, verifier }), { expirationTtl: 600 });
    const redirectUri = `${originOf(c)}/auth/${provider}/callback`;
    const clientId = provider === "google" ? c.env.GOOGLE_CLIENT_ID! : c.env.GITHUB_CLIENT_ID!;
    const challenge = provider === "google" ? await pkceChallenge(verifier) : undefined;
    return c.redirect(authorizeUrl(provider, { clientId, redirectUri, state, challenge }));
  });

  a.get("/auth/:provider/callback", async (c) => {
    const provider = c.req.param("provider") as Provider;
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.text("missing code/state", 400);
    const stored = await c.env.OAUTH_STATE.get(`oauth:${state}`);
    if (!stored) return c.text("invalid or expired state", 400);
    await c.env.OAUTH_STATE.delete(`oauth:${state}`);
    const { verifier } = JSON.parse(stored) as { verifier: string };
    const redirectUri = `${originOf(c)}/auth/${provider}/callback`;
    const clientId = provider === "google" ? c.env.GOOGLE_CLIENT_ID! : c.env.GITHUB_CLIENT_ID!;
    const clientSecret = provider === "google" ? c.env.GOOGLE_CLIENT_SECRET! : c.env.GITHUB_CLIENT_SECRET!;
    let ident;
    try {
      ident = await completeOAuth(provider, { code, clientId, clientSecret, redirectUri, verifier });
    } catch {
      return c.redirect("/app?error=signin_failed");
    }
    const user = await new SocialRepo(c.env.DB).upsertByIdentity({
      provider,
      providerUid: ident.providerUid,
      email: ident.email,
      displayName: ident.displayName,
      emailVerified: ident.emailVerified,
    });
    await startSession(c, user.id);
    return c.redirect("/app");
  });

  // ── Cloudflare Access (email one-time-PIN) ──────────────────────────────
  // This path sits behind an Access application; Cloudflare authenticates the
  // user (emails a code) and forwards the request with a signed JWT we verify.
  a.get("/auth/access/login", async (c) => {
    if (!c.env.ACCESS_TEAM_DOMAIN || !c.env.ACCESS_AUD) return c.text("Cloudflare Access isn't configured yet", 503);
    const ident = await fetchAccessIdentity(c.req.raw, { teamDomain: c.env.ACCESS_TEAM_DOMAIN, aud: c.env.ACCESS_AUD });
    if (!ident) return c.redirect("/app?error=access_denied");
    const user = await new SocialRepo(c.env.DB).upsertByIdentity({
      provider: "access",
      providerUid: ident.email,
      email: ident.email,
      displayName: ident.email.split("@")[0] || ident.email,
      emailVerified: true,
    });
    await startSession(c, user.id);
    return c.redirect("/app");
  });

  // ── email + password (self-contained; no external provider needed) ────────────
  a.post("/auth/password/register", async (c) => {
    const { email, password, name } = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string; name?: string };
    if (!email || !EMAIL_RE.test(email)) return c.json({ error: "valid email required" }, 400);
    const weak = passwordProblem(password);
    if (weak) return c.json({ error: weak }, 400);
    const social = new SocialRepo(c.env.DB);
    // Refuse if ANY account already uses this email (any provider). Password
    // register must never attach a credential + session to a pre-existing,
    // possibly-verified account created elsewhere — that would be a takeover.
    if (await social.findByEmail(email)) return c.json({ error: "an account with this email already exists — sign in instead" }, 409);
    const user = await social.upsertByIdentity({
      provider: "password",
      providerUid: email.toLowerCase(),
      email,
      displayName: name || email.split("@")[0] || email,
      emailVerified: false,
    });
    await social.setPasswordCredential(user.id, email, await hashPassword(password!));
    await startSession(c, user.id);
    return c.json({ ok: true, user });
  });

  a.post("/auth/password/login", async (c) => {
    const { email, password } = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string };
    if (!email || !password) return c.json({ error: "email and password required" }, 400);
    const social = new SocialRepo(c.env.DB);
    const cred = await social.getPasswordCredential(email);
    // Equalize response time whether the email is unknown or the password is wrong:
    // if there's no credential, still run a PBKDF2 against a dummy so an attacker
    // can't enumerate registered emails by timing. Same 401 either way.
    const good = await verifyPassword(password, cred ?? DUMMY_HASH);
    if (!cred || !good) return c.json({ error: "invalid email or password" }, 401);
    await startSession(c, cred.userId);
    return c.json({ ok: true });
  });

  // ── email magic link ────────────────────────────────────────────────────
  a.post("/auth/email", async (c) => {
    const { email } = (await c.req.json().catch(() => ({}))) as { email?: string };
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: "valid email required" }, 400);
    const dev = c.env.DEV_LOGIN === "1";
    // Without an email provider we can't deliver the link. Only in dev do we
    // surface it in the response (never leak a sign-in link to a caller in prod).
    if (!c.env.RESEND_API_KEY && !dev) return c.json({ error: "email sign-in not configured yet" }, 503);
    const res = await requestMagicLink(c.env, email, originOf(c));
    return c.json({ sent: true, ...(dev && res.devLink ? { devLink: res.devLink } : {}) });
  });

  a.get("/auth/email/verify", async (c) => {
    const t = c.req.query("token");
    if (!t) return c.text("missing token", 400);
    const email = await verifyMagicLink(c.env, t);
    if (!email) return c.redirect("/app?error=link_expired");
    const user = await new SocialRepo(c.env.DB).upsertByIdentity({
      provider: "email",
      providerUid: email,
      email,
      displayName: email.split("@")[0] || email,
      emailVerified: true,
    });
    await startSession(c, user.id);
    return c.redirect("/app");
  });

  // ── dev login (only when DEV_LOGIN=1) ───────────────────────────────────
  // Lets us build & test the whole social platform before OAuth creds exist.
  a.post("/auth/dev", async (c) => {
    if (c.env.DEV_LOGIN !== "1") return c.json({ error: "disabled" }, 403);
    const { email, name } = (await c.req.json().catch(() => ({}))) as { email?: string; name?: string };
    if (!email) return c.json({ error: "email required" }, 400);
    const user = await new SocialRepo(c.env.DB).upsertByIdentity({
      provider: "dev",
      providerUid: email,
      email,
      displayName: name || email.split("@")[0] || email,
      emailVerified: true,
    });
    await startSession(c, user.id);
    return c.json({ ok: true, user });
  });

  a.post("/auth/logout", async (c) => {
    await endSession(c);
    return c.json({ ok: true });
  });

  return a;
}
