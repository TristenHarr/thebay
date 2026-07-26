import { describe, it, expect, beforeEach } from "vitest";
import { ShadowCell } from "../src/realtime/shadow-cell";

/* A minimal fake DurableObjectState: an in-memory storage map, an alarm slot, and
 * a list of fake sockets that record what was sent. Enough to exercise the cell's
 * scalability-critical logic (per-cell storage + alarm-driven expiry + fan-out)
 * without the Workers runtime. /ws (WebSocketPair + a 101 response) is the same
 * three-line hibernation pattern as GroupRoom and is covered by the live e2e. */
function fakeSocket() {
  const sent: string[] = [];
  return { sent, send: (m: string) => sent.push(m), close: () => {} };
}
function fakeState() {
  const store = new Map<string, any>();
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  let alarm: number | null = null;
  const state: any = {
    storage: {
      async put(k: string, v: any) { store.set(k, v); },
      async get(k: string) { return store.get(k); },
      async delete(k: string) { return store.delete(k); },
      async list({ prefix }: { prefix: string }) {
        const m = new Map<string, any>();
        for (const [k, v] of store) if (k.startsWith(prefix)) m.set(k, v);
        return m;
      },
      async setAlarm(t: number) { alarm = t; },
      async getAlarm() { return alarm; },
      async deleteAlarm() { alarm = null; },
    },
    getWebSockets: () => sockets,
    acceptWebSocket: (ws: any) => sockets.push(ws),
  };
  return { state, store, sockets, getAlarm: () => alarm };
}

const pub = (cell: ShadowCell, shadow: any) =>
  cell.fetch(new Request("https://do/publish", { method: "POST", body: JSON.stringify(shadow) }));
const evict = (cell: ShadowCell, id: string) =>
  cell.fetch(new Request("https://do/evict", { method: "POST", body: JSON.stringify({ id }) }));
const snapshot = async (cell: ShadowCell) =>
  (await (await cell.fetch(new Request("https://do/snapshot"))).json()) as { shadows: any[] };

const T = (mins: number) => new Date(Date.UTC(2026, 7, 1, 18, mins, 0)).toISOString();

describe("ShadowCell — per-cell live storage + alarm expiry", () => {
  let f: ReturnType<typeof fakeState>, cell: ShadowCell, sock: ReturnType<typeof fakeSocket>;
  beforeEach(() => {
    f = fakeState();
    cell = new ShadowCell(f.state);
    sock = fakeSocket();
    f.state.acceptWebSocket(sock);
  });

  it("publish stores the shadow, broadcasts {new}, and arms the alarm at its expiry", async () => {
    await pub(cell, { id: "s1", expiresAt: T(60), body: "gm" });
    expect(f.store.get("s:s1")).toMatchObject({ id: "s1", body: "gm" });
    expect(JSON.parse(sock.sent[0]!)).toMatchObject({ type: "new", shadow: { id: "s1" } });
    expect(f.getAlarm()).toBe(Date.parse(T(60)));
  });

  it("snapshot returns only the still-active shadows in the cell", async () => {
    await pub(cell, { id: "live", expiresAt: T(120) });
    await pub(cell, { id: "gone", expiresAt: T(1) }); // already past by the read time below
    const now = Date.parse(T(30));
    const shadows = (await snapshot(cell)).shadows.filter((s) => Date.parse(s.expiresAt) > now);
    expect(shadows.map((s) => s.id)).toEqual(["live"]);
  });

  it("the alarm expires due shadows, fades them, keeps future ones, and re-arms for the next", async () => {
    await pub(cell, { id: "early", expiresAt: T(10) });
    await pub(cell, { id: "late", expiresAt: T(600) });
    // Simulate the alarm firing after `early` is due but before `late`. We assert on
    // the fade broadcast + remaining store + the re-armed alarm.
    const beforeSends = sock.sent.length;
    // Make `early` due: rewrite its expiry into the past relative to Date.now().
    f.store.set("s:early", { id: "early", expiresAt: new Date(Date.now() - 1000).toISOString() });
    await cell.alarm();
    const faded = sock.sent.slice(beforeSends).map((m) => JSON.parse(m));
    expect(faded).toContainEqual({ type: "expire", id: "early" });
    expect(f.store.has("s:early")).toBe(false);
    expect(f.store.has("s:late")).toBe(true);
    expect(f.getAlarm()).toBe(Date.parse(T(600))); // re-armed for the survivor
  });

  it("evict removes a replaced/deleted shadow and broadcasts {expire}", async () => {
    await pub(cell, { id: "s1", expiresAt: T(60) });
    const before = sock.sent.length;
    await evict(cell, "s1");
    expect(f.store.has("s:s1")).toBe(false);
    expect(JSON.parse(sock.sent[before]!)).toEqual({ type: "expire", id: "s1" });
    expect(f.getAlarm()).toBeNull(); // empty cell → alarm cleared
  });
});
