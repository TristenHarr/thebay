import { describe, it, expect, vi, afterEach } from "vitest";
import { pushEvents } from "../src/pipeline/ingest-client";

const ev = (i: number) => ({ id: "e" + i, title: "E" + i }) as any;
const events = (n: number) => Array.from({ length: n }, (_, i) => ev(i));

afterEach(() => vi.restoreAllMocks());

/** Mock global.fetch; capture each request body so we can assert batching. */
function mockFetch(handler: (bodies: any[], call: number) => { ok: boolean; json?: any }) {
  const bodies: any[] = [];
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const r = handler(bodies, call++);
    return { ok: r.ok, status: r.ok ? 200 : 500, json: async () => r.json ?? {} } as any;
  }));
  return bodies;
}

describe("pushEvents — the local→prod ingest bridge", () => {
  it("batches by batchSize and accumulates inserted/updated across batches", async () => {
    const bodies = mockFetch(() => ({ ok: true, json: { inserted: 3, updated: 2 } }));
    const r = await pushEvents(events(1200), { baseUrl: "https://thebay.events", token: "t", batchSize: 500 });
    expect(r.batches).toBe(3); // 500 + 500 + 200
    expect(bodies.map((b) => b.events.length)).toEqual([500, 500, 200]);
    expect(r).toMatchObject({ inserted: 9, updated: 6, failed: 0 }); // 3 batches × {3,2}
  });

  it("sends the bearer token and hits /api/admin/ingest (trailing slash trimmed)", async () => {
    mockFetch(() => ({ ok: true, json: { inserted: 1, updated: 0 } }));
    await pushEvents(events(1), { baseUrl: "https://thebay.events/", token: "secret" });
    const call = (fetch as any).mock.calls[0];
    expect(call[0]).toBe("https://thebay.events/api/admin/ingest");
    expect(call[1].headers.authorization).toBe("Bearer secret");
  });

  it("counts a rejected batch (non-2xx) as failed without sinking the others", async () => {
    mockFetch((_b, call) => (call === 1 ? { ok: false } : { ok: true, json: { inserted: 5, updated: 0 } }));
    const r = await pushEvents(events(1500), { baseUrl: "https://x", token: "t", batchSize: 500 });
    expect(r.batches).toBe(3);
    expect(r.failed).toBe(500); // the middle batch
    expect(r.inserted).toBe(10); // the two good batches
  });

  it("counts a thrown network error as failed for that batch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const r = await pushEvents(events(300), { baseUrl: "https://x", token: "t" });
    expect(r).toMatchObject({ batches: 1, failed: 300, inserted: 0 });
  });

  it("does nothing (no request) for an empty event list", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const r = await pushEvents([], { baseUrl: "https://x", token: "t" });
    expect(f).not.toHaveBeenCalled();
    expect(r).toMatchObject({ batches: 0, inserted: 0, updated: 0, failed: 0 });
  });
});
