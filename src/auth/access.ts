/**
 * Cloudflare Access (Zero Trust) JWT verification.
 *
 * The Access application sits in front of `/auth/access/login`. On success
 * Cloudflare forwards the request with a signed RS256 JWT in the
 * `Cf-Access-Jwt-Assertion` header. We verify it against the team JWKS, check
 * the audience (the Access app's AUD tag) and expiry, and trust the `email`.
 *
 * `verifyAccessJwt` is pure (takes the JWKS in), so it's unit-testable with a
 * locally-minted key; `fetchAccessIdentity` wires the header + JWKS fetch.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
function b64urlJson(s: string): any {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(s)));
}

export interface AccessIdentity {
  email: string;
}
export interface Jwks {
  keys: any[];
}

/** Verify a Cloudflare Access RS256 JWT. Returns the identity, or null if the
 *  signature, audience, expiry, key, or email don't check out. */
export async function verifyAccessJwt(
  token: string,
  opts: { jwks: Jwks; aud: string; now?: number },
): Promise<AccessIdentity | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts as [string, string, string];

  let header: any;
  let claims: any;
  try {
    header = b64urlJson(h);
    claims = b64urlJson(p);
  } catch {
    return null;
  }

  const jwk = opts.jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlDecode(sig),
      new TextEncoder().encode(`${h}.${p}`),
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  // audience: Access sends `aud` as an array (or occasionally a string)
  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.includes(opts.aud) : aud === opts.aud;
  if (!audOk) return null;

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && claims.exp < now) return null;

  if (!claims.email || typeof claims.email !== "string") return null;
  return { email: claims.email };
}

const jwksCache: { url?: string; at: number; jwks?: Jwks } = { at: 0 };

/** Verify the request's Access JWT. `teamDomain` e.g. "thebay.cloudflareaccess.com",
 *  `aud` is the Access application's AUD tag. JWKS is cached ~10 min. */
export async function fetchAccessIdentity(
  request: { headers: { get(name: string): string | null } },
  opts: { teamDomain: string; aud: string; fetchImpl?: typeof fetch },
): Promise<AccessIdentity | null> {
  const token =
    request.headers.get("cf-access-jwt-assertion") ||
    request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;

  const url = `https://${opts.teamDomain}/cdn-cgi/access/certs`;
  const f = opts.fetchImpl ?? fetch;
  const fresh = Date.now() - jwksCache.at < 10 * 60 * 1000;
  if (!jwksCache.jwks || jwksCache.url !== url || !fresh) {
    const res = await f(url);
    if (!res.ok) return null;
    jwksCache.jwks = (await res.json()) as Jwks;
    jwksCache.url = url;
    jwksCache.at = Date.now();
  }
  return verifyAccessJwt(token, { jwks: jwksCache.jwks, aud: opts.aud });
}
