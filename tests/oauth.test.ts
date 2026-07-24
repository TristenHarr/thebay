import { describe, it, expect } from "vitest";
import { base64url, pkceChallenge, authorizeUrl, randomString } from "../src/auth/oauth";

describe("oauth pure helpers", () => {
  it("base64url is url-safe (no +, /, =)", () => {
    const s = base64url(new Uint8Array([251, 255, 191, 0, 1, 2]).buffer);
    expect(s).not.toMatch(/[+/=]/);
  });

  it("randomString yields distinct url-safe tokens", () => {
    const a = randomString(24);
    const b = randomString(24);
    expect(a).not.toBe(b);
    expect(a).not.toMatch(/[+/=]/);
    expect(a.length).toBeGreaterThan(20);
  });

  it("pkceChallenge is deterministic, S256 length (43 chars)", async () => {
    const v = "the-fixed-verifier-value-123456789";
    const c1 = await pkceChallenge(v);
    const c2 = await pkceChallenge(v);
    expect(c1).toBe(c2);
    expect(c1.length).toBe(43); // sha-256 → 32 bytes → 43 base64url chars
    expect(await pkceChallenge("different")).not.toBe(c1);
  });

  it("authorizeUrl includes PKCE challenge for google, omits it for github", () => {
    const g = new URL(
      authorizeUrl("google", { clientId: "gid", redirectUri: "https://x/cb", state: "st", challenge: "ch" }),
    );
    expect(g.origin + g.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(g.searchParams.get("client_id")).toBe("gid");
    expect(g.searchParams.get("redirect_uri")).toBe("https://x/cb");
    expect(g.searchParams.get("state")).toBe("st");
    expect(g.searchParams.get("code_challenge")).toBe("ch");
    expect(g.searchParams.get("code_challenge_method")).toBe("S256");
    expect(g.searchParams.get("scope")).toContain("email");

    const h = new URL(authorizeUrl("github", { clientId: "hid", redirectUri: "https://x/cb", state: "st" }));
    expect(h.origin + h.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(h.searchParams.get("code_challenge")).toBeNull();
    expect(h.searchParams.get("scope")).toContain("user:email");
  });
});
