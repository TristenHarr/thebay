/**
 * Magic-link invariants. The one that matters is single-use under CONCURRENCY:
 * a read-then-write consume lets two simultaneous clicks on the same emailed link
 * both mint a session, which turns a leaked/forwarded link into a durable account
 * compromise. The claim has to be one atomic UPDATE.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { requestMagicLink, verifyMagicLink } from "../src/auth/magic";
import { makeTestEnv } from "./helpers/app";

/** Same Env, but statement READS resolve a macrotask late while still hitting the
 *  DB at call time — the only way to open a real check-then-act window on top of
 *  a synchronous SQLite shim. Writes are untouched. */
function deferredReads(env: any): any {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    ...env,
    DB: {
      prepare(sql: string) {
        const st = env.DB.prepare(sql);
        return {
          bind(...a: any[]) { st.bind(...a); return this; },
          async first() { const p = st.first(); await tick(); return p; },
          async all() { const p = st.all(); await tick(); return p; },
          run() { return st.run(); },
        };
      },
    },
  };
}

describe("magic links", () => {
  let env: any;
  beforeEach(() => { ({ env } = makeTestEnv()); });

  const tokenOf = (link: string) => new URL(link).searchParams.get("token")!;

  it("issues a dev link and consumes it exactly once", async () => {
    const { devLink } = await requestMagicLink(env, "Ann@Example.com", "https://thebay.events");
    expect(devLink).toBeTruthy();
    const t = tokenOf(devLink!);

    expect(await verifyMagicLink(env, t)).toBe("ann@example.com"); // email is lowercased
    expect(await verifyMagicLink(env, t)).toBeNull(); // already used
  });

  it("does not let two CONCURRENT redemptions both succeed", async () => {
    const { devLink } = await requestMagicLink(env, "bob@example.com", "https://thebay.events");
    const t = tokenOf(devLink!);

    // A bare Promise.all does NOT reproduce the race: better-sqlite3 is synchronous,
    // so the two calls serialize and a read-then-write consume passes anyway
    // (verified — the old implementation returns [email, null] here too).
    // To make the TOCTOU window real we delay only the RESOLUTION of reads, while
    // the underlying SELECT still executes at call time. That interleaves as
    // SELECT₁ SELECT₂ UPDATE₁ UPDATE₂ — under which a read-then-write consume
    // returns the email twice, and an atomic guarded UPDATE returns it once.
    const [a, b] = await Promise.all([
      verifyMagicLink(deferredReads(env), t),
      verifyMagicLink(deferredReads(env), t),
    ]);
    expect([a, b].filter(Boolean)).toEqual(["bob@example.com"]);
  });

  it("rejects an unknown token", async () => {
    expect(await verifyMagicLink(env, "nope")).toBeNull();
  });

  it("rejects an expired token without consuming a valid one", async () => {
    const { devLink } = await requestMagicLink(env, "cara@example.com", "https://thebay.events");
    const t = tokenOf(devLink!);
    // Backdate it past the 15-minute window.
    env.DB.db.prepare("UPDATE magic_links SET expires_at = ?").run("2000-01-01T00:00:00.000Z");
    expect(await verifyMagicLink(env, t)).toBeNull();
  });
});
