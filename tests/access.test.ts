import { describe, it, expect, beforeAll } from "vitest";
import { verifyAccessJwt } from "../src/auth/access";

/**
 * Cloudflare Access sends a signed RS256 JWT in the Cf-Access-Jwt-Assertion header.
 * We verify it against the team JWKS, check `aud` + `exp`, and trust the `email`.
 * These tests mint real RSA-signed tokens with Web Crypto (available in Node 20)
 * so we exercise the actual signature path — no mocking of crypto.
 */

const b64url = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlJson = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

let jwks: { keys: any[] };
let privateKey: any; // CryptoKey (not in the Node lib types)
const KID = "test-key-1";
const AUD = "aud-tag-123";

async function signJwt(claims: Record<string, unknown>, kid = KID): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(sig)}`;
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  privateKey = pair.privateKey;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as any;
  pub.kid = KID;
  pub.alg = "RS256";
  jwks = { keys: [pub] };
});

const future = Math.floor(Date.now() / 1000) + 600;
const past = Math.floor(Date.now() / 1000) - 600;

describe("verifyAccessJwt", () => {
  it("accepts a valid token and returns the verified email", async () => {
    const token = await signJwt({ email: "founder@x.com", aud: [AUD], exp: future });
    const id = await verifyAccessJwt(token, { jwks, aud: AUD });
    expect(id).toEqual({ email: "founder@x.com" });
  });

  it("accepts aud as a string too", async () => {
    const token = await signJwt({ email: "a@x.com", aud: AUD, exp: future });
    expect(await verifyAccessJwt(token, { jwks, aud: AUD })).toEqual({ email: "a@x.com" });
  });

  it("rejects a tampered payload", async () => {
    const token = await signJwt({ email: "a@x.com", aud: [AUD], exp: future });
    const parts = token.split(".");
    parts[1] = b64urlJson({ email: "attacker@x.com", aud: [AUD], exp: future });
    expect(await verifyAccessJwt(parts.join("."), { jwks, aud: AUD })).toBeNull();
  });

  it("rejects the wrong audience", async () => {
    const token = await signJwt({ email: "a@x.com", aud: ["other"], exp: future });
    expect(await verifyAccessJwt(token, { jwks, aud: AUD })).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await signJwt({ email: "a@x.com", aud: [AUD], exp: past });
    expect(await verifyAccessJwt(token, { jwks, aud: AUD })).toBeNull();
  });

  it("rejects an unknown signing key (kid)", async () => {
    const token = await signJwt({ email: "a@x.com", aud: [AUD], exp: future }, "unknown-kid");
    expect(await verifyAccessJwt(token, { jwks, aud: AUD })).toBeNull();
  });

  it("rejects a token with no email", async () => {
    const token = await signJwt({ aud: [AUD], exp: future });
    expect(await verifyAccessJwt(token, { jwks, aud: AUD })).toBeNull();
  });
});
