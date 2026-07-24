/**
 * Self-contained password auth — no external identity provider needed. Hashes
 * with PBKDF2-HMAC-SHA256 (Web Crypto, available on the Workers runtime), a random
 * per-user salt, and a constant-time compare. Everything a login needs lives in
 * D1; nothing leaves the edge.
 */
const ITERATIONS = 100_000;
const enc = (s: string) => new TextEncoder().encode(s);

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface PasswordHash {
  salt: string; // base64
  hash: string; // base64
  iterations: number;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  return new Uint8Array(bits);
}

/** Hash a password with a fresh random salt (or a supplied one, for tests). */
export async function hashPassword(password: string, iterations = ITERATIONS, saltBytes?: Uint8Array): Promise<PasswordHash> {
  const salt = saltBytes ?? crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, iterations);
  return { salt: b64(salt), hash: b64(hash), iterations };
}

/** Constant-time verification against a stored hash. */
export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const derived = await derive(password, unb64(stored.salt), stored.iterations);
  const expected = unb64(stored.hash);
  if (derived.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < derived.length; i++) diff |= derived[i]! ^ expected[i]!;
  return diff === 0;
}

/**
 * A fixed, valid hash used ONLY to equalize login timing: when an email isn't
 * registered, the route still runs verifyPassword against this so the response
 * time doesn't reveal whether the account exists (no email enumeration). It never
 * matches a real password (independent random salt).
 */
export const DUMMY_HASH: PasswordHash = {
  // Random bytes (not the PBKDF2 of any password), so no input ever matches it.
  salt: "bdsoSVvH13qQ1kfybjY5Xg==",
  hash: "9ZRx0AQn5FKpZp7VeNxTj7xcaex7otGG5qqC1SVOqRI=",
  iterations: 100_000,
};

/** Basic strength gate — enough to stop the obviously-bad, not a policy sermon. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length < 8) return "password must be at least 8 characters";
  if (password.length > 200) return "password too long";
  return null;
}
