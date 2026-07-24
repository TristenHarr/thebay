/**
 * Minimal, dependency-free OAuth2 (authorization-code) for Google & GitHub.
 * Google uses PKCE; both use an opaque `state` we persist in KV for CSRF defense.
 * Pure helpers (base64url / PKCE / URL building) are unit-tested; the network
 * exchange lives behind small functions the routes call.
 */
export type Provider = "google" | "github";

interface ProviderConfig {
  authUrl: string;
  tokenUrl: string;
  scope: string;
  pkce: boolean;
}
const PROVIDERS: Record<Provider, ProviderConfig> = {
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
    pkce: true,
  },
  github: {
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email",
    pkce: false,
  },
};

// ── pure helpers (tested) ─────────────────────────────────────────────────────
export function base64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function randomString(len = 48): string {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return base64url(a.buffer);
}
export async function sha256(str: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
}
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(await sha256(verifier));
}

export function authorizeUrl(
  provider: Provider,
  opts: { clientId: string; redirectUri: string; state: string; challenge?: string },
): string {
  const cfg = PROVIDERS[provider];
  const p = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: cfg.scope,
    state: opts.state,
  });
  if (provider === "google") {
    p.set("access_type", "online");
    p.set("prompt", "select_account");
  }
  if (cfg.pkce && opts.challenge) {
    p.set("code_challenge", opts.challenge);
    p.set("code_challenge_method", "S256");
  }
  return `${cfg.authUrl}?${p.toString()}`;
}

export interface OAuthIdentity {
  providerUid: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
}

// ── network exchange ─────────────────────────────────────────────────────────
async function exchangeCode(
  provider: Provider,
  opts: { code: string; clientId: string; clientSecret: string; redirectUri: string; verifier?: string },
): Promise<string> {
  const cfg = PROVIDERS[provider];
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    grant_type: "authorization_code",
    redirect_uri: opts.redirectUri,
  });
  if (opts.verifier) body.set("code_verifier", opts.verifier);
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`${provider} token exchange failed: ${res.status}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error(`${provider} returned no access_token`);
  return json.access_token;
}

async function fetchIdentity(provider: Provider, accessToken: string): Promise<OAuthIdentity> {
  const ua = { "user-agent": "thebay.events", authorization: `Bearer ${accessToken}` };
  if (provider === "google") {
    const u = (await (await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: ua })).json()) as any;
    return { providerUid: String(u.sub), email: u.email, displayName: u.name || u.email, emailVerified: !!u.email_verified };
  }
  // github
  const u = (await (await fetch("https://api.github.com/user", { headers: ua })).json()) as any;
  let email: string | undefined = u.email;
  let verified = false;
  const emails = (await (await fetch("https://api.github.com/user/emails", { headers: ua })).json()) as any[];
  if (Array.isArray(emails)) {
    const primary = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified);
    if (primary) { email = primary.email; verified = true; }
  }
  if (!email) email = `${u.login}@users.noreply.github.com`;
  return { providerUid: String(u.id), email, displayName: u.name || u.login, emailVerified: verified };
}

/** Full callback exchange: code → access token → normalized identity. */
export async function completeOAuth(
  provider: Provider,
  opts: { code: string; clientId: string; clientSecret: string; redirectUri: string; verifier?: string },
): Promise<OAuthIdentity> {
  const token = await exchangeCode(provider, opts);
  return fetchIdentity(provider, token);
}

export const providerConfigured = (provider: Provider, env: { GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string }) =>
  provider === "google" ? !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) : !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
