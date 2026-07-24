/**
 * Minimal VAPID web-push. Sends a signed, bodyless "tickle" to a push service —
 * the browser wakes our service worker's `push` handler, which shows the
 * notification. (Encrypted payloads are a later upgrade; a tickle is enough to
 * fire intros/check-in/chat alerts and is far simpler to get right.)
 *
 * VAPID keys: VAPID_PUBLIC_KEY is the base64url raw P-256 point (65 bytes,
 * 0x04‖x‖y); VAPID_PRIVATE_KEY is the base64url 32-byte scalar `d`. Generate with
 * `npx web-push generate-vapid-keys`.
 */
export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlJson = (obj: unknown) => b64urlEncode(new TextEncoder().encode(JSON.stringify(obj)));

// Derive the key type from the ambient Web Crypto global (backend tsconfig has no DOM lib).
type CryptoKeyT = Awaited<ReturnType<(typeof crypto)["subtle"]["importKey"]>>;

/** Import a VAPID keypair into a signing key by reconstructing the JWK from the
 *  private scalar `d` and the raw public point. */
export async function importVapidKey(privateB64url: string, publicB64url: string): Promise<CryptoKeyT> {
  const pub = b64urlToBytes(publicB64url);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error("VAPID public key must be a 65-byte uncompressed P-256 point");
  const jwk = { kty: "EC", crv: "P-256", d: privateB64url, x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33, 65)), ext: true };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/** Build a signed ES256 VAPID JWT for the given push-service audience. */
export async function buildVapidJwt(key: CryptoKeyT, audience: string, subject: string, nowSec: number): Promise<string> {
  const header = b64urlJson({ typ: "JWT", alg: "ES256" });
  const claims = b64urlJson({ aud: audience, exp: nowSec + 12 * 3600, sub: subject });
  const input = `${header}.${claims}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input)));
  return `${input}.${b64urlEncode(sig)}`; // subtle returns raw r‖s — exactly JWS ES256
}

export interface PushSub { endpoint: string; p256dh?: string; auth?: string }
export interface VapidEnv { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string }

/** Send a bodyless push. Returns the push service's Response (404/410 ⇒ prune). */
export async function sendPush(sub: PushSub, env: VapidEnv, nowSec = Math.floor(Date.now() / 1000)): Promise<Response> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) throw new Error("VAPID keys not configured");
  const key = await importVapidKey(env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY);
  const audience = new URL(sub.endpoint).origin;
  const jwt = await buildVapidJwt(key, audience, env.VAPID_SUBJECT || "mailto:hello@thebay.events", nowSec);
  return fetch(sub.endpoint, {
    method: "POST",
    headers: { TTL: "2419200", Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`, "Content-Length": "0" },
  });
}
