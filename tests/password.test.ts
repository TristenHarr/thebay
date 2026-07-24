import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, passwordProblem, DUMMY_HASH } from "../src/auth/password";

describe("password hashing", () => {
  it("verifies the correct password and rejects a wrong one", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", h)).toBe(true);
    expect(await verifyPassword("wrong password", h)).toBe(false);
  });

  it("uses a random salt so identical passwords hash differently", async () => {
    const a = await hashPassword("samepass");
    const b = await hashPassword("samepass");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    // …yet each still verifies its own
    expect(await verifyPassword("samepass", a)).toBe(true);
    expect(await verifyPassword("samepass", b)).toBe(true);
  });

  it("fails verification if the stored hash is tampered with", async () => {
    const h = await hashPassword("hunter2hunter2");
    expect(await verifyPassword("hunter2hunter2", { ...h, hash: "AAAA" })).toBe(false);
  });

  it("DUMMY_HASH is a well-formed hash that never matches (anti-enumeration decoy)", async () => {
    // it must be verifiable-shaped (100k iters) so login can burn equal CPU when
    // an email is unknown, yet never accept a real password.
    expect(DUMMY_HASH.iterations).toBe(100_000);
    expect(await verifyPassword("thebay-dummy", DUMMY_HASH)).toBe(false);
    expect(await verifyPassword("anything", DUMMY_HASH)).toBe(false);
  });

  it("gates weak passwords", () => {
    expect(passwordProblem("short")).toMatch(/8 characters/);
    expect(passwordProblem(12345678 as any)).toMatch(/8 characters/);
    expect(passwordProblem("longenough")).toBeNull();
  });
});
