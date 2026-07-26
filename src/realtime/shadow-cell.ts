import type { DurableObjectState } from "@cloudflare/workers-types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * ShadowCell — one Durable Object per geohash cell (precision ~6 ≈ 1.2km),
 * addressed `idFromName(cell)`. This is the unit of horizontal sharding that makes
 * the live board infinitely scalable: load spreads across as many DOs as there are
 * active places, each independent and globally placed by Cloudflare on demand. A
 * viral cell (a big hackathon) is ONE hot object that cannot touch any other cell.
 *
 * Each cell owns three things and shares nothing:
 *   1. Its live WebSocket subscribers (hibernation API — an idle cell costs nothing).
 *   2. Its active shadows, in DO storage — so a zoomed-in live read is served from
 *      the cell, never from D1 (D1 is only the durable backstop + heat aggregate).
 *   3. Its own alarm — the earliest `expires_at` in the cell. When it fires, the
 *      cell expires its due shadows and broadcasts the fade. Expiry shards with the
 *      cells; there is no central expiry pass.
 *
 * Messages (all JSON): `{type:'new', shadow}` · `{type:'expire', id}` · `{type:'pong'}`.
 *
 * The Worker is authoritative for persistence + moderation (D1); it POSTs here to
 * fan out. Everything this powers is progressive enhancement — GET /api/shadows
 * (D1) renders the same shadows if a socket never opens.
 */
const KEY = (id: string) => `s:${id}`;
const PREFIX = "s:";

interface CellShadow {
  id: string;
  expiresAt: string; // ISO — drives the alarm + snapshot filter
  [k: string]: unknown; // the full public shadow payload (author, kind, body, …)
}

export class ShadowCell {
  constructor(private state: DurableObjectState) {}

  private broadcast(payload: unknown): void {
    const body = JSON.stringify(payload);
    for (const ws of this.state.getWebSockets()) {
      try {
        (ws as any).send(body);
      } catch {
        /* dropped socket — never take the cell down for one dead connection */
      }
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // A client subscribes to this cell's live stream.
    if (url.pathname.endsWith("/ws")) {
      const pair = new (globalThis as any).WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client } as any);
    }

    // The Worker fans out a freshly-persisted shadow: store it, arm the alarm, relay it.
    if (url.pathname.endsWith("/publish")) {
      const shadow = JSON.parse(await req.text()) as CellShadow;
      await this.state.storage.put(KEY(shadow.id), shadow);
      this.broadcast({ type: "new", shadow });
      await this.reschedule();
      return new Response("ok");
    }

    // A shadow was replaced (1-per-account) or deleted — evict + fade it here.
    if (url.pathname.endsWith("/evict")) {
      const { id } = JSON.parse(await req.text()) as { id: string };
      await this.state.storage.delete(KEY(id));
      this.broadcast({ type: "expire", id });
      await this.reschedule();
      return new Response("ok");
    }

    // Snapshot for a newcomer: this cell's still-active shadows, served from the DO.
    if (url.pathname.endsWith("/snapshot")) {
      const now = Date.now();
      const shadows = (await this.all()).filter((s) => Date.parse(s.expiresAt) > now);
      return new Response(JSON.stringify({ shadows }), { headers: { "content-type": "application/json" } });
    }

    return new Response("not found", { status: 404 });
  }

  /** Alarm: expire everything past its 24h, broadcast the fade, re-arm for the next. */
  async alarm(): Promise<void> {
    const now = Date.now();
    for (const s of await this.all()) {
      if (Date.parse(s.expiresAt) <= now) {
        await this.state.storage.delete(KEY(s.id));
        this.broadcast({ type: "expire", id: s.id });
      }
    }
    await this.reschedule();
  }

  private async all(): Promise<CellShadow[]> {
    const map = await this.state.storage.list<CellShadow>({ prefix: PREFIX });
    return [...map.values()];
  }

  /** Arm the alarm at the earliest expiry left in the cell (or clear it if empty). */
  private async reschedule(): Promise<void> {
    const all = await this.all();
    if (!all.length) {
      await this.state.storage.deleteAlarm();
      return;
    }
    const next = Math.min(...all.map((s) => Date.parse(s.expiresAt)));
    await this.state.storage.setAlarm(next);
  }

  webSocketMessage(ws: any, message: any): void {
    if (message === "ping") {
      try {
        ws.send(JSON.stringify({ type: "pong" }));
      } catch {
        /* ignore */
      }
    }
  }
  webSocketClose(ws: any): void {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  webSocketError(ws: any): void {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}
