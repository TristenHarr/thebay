import { describe, it, expect } from "vitest";
import { b64urlEncode, b64urlToBytes, importVapidKey, buildVapidJwt } from "../src/push/webpush";

// Generate a P-256 keypair and export it in the VAPID wire format the module expects.
async function genVapid() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)); // 0x04‖x‖y
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { publicB64: b64urlEncode(raw), privateB64: jwk.d as string, verifyKey: kp.publicKey };
}

describe("base64url round-trip", () => {
  it("encodes and decodes bytes without padding", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 65, 66]);
    expect(b64urlEncode(bytes)).not.toMatch(/[+/=]/);
    expect([...b64urlToBytes(b64urlEncode(bytes))]).toEqual([...bytes]);
  });
});

describe("VAPID JWT", () => {
  it("signs an ES256 JWT that verifies against the public key, with correct claims", async () => {
    const { publicB64, privateB64, verifyKey } = await genVapid();
    const key = await importVapidKey(privateB64, publicB64);
    const now = 1_800_000_000;
    const jwt = await buildVapidJwt(key, "https://fcm.googleapis.com", "mailto:hi@thebay.events", now);

    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(b64urlToBytes(h!)))).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(c!)));
    expect(claims).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "mailto:hi@thebay.events", exp: now + 12 * 3600 });

    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifyKey,
      b64urlToBytes(s!),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(valid).toBe(true);
  });

  it("rejects a malformed public key", async () => {
    await expect(importVapidKey("abc", b64urlEncode(new Uint8Array(10)))).rejects.toThrow(/P-256 point/);
  });
});
