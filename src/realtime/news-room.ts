import type { DurableObjectState } from "@cloudflare/workers-types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * NewsRoom — one Durable Object per story. Two jobs, both deliberately small:
 *
 *   1. PRESENCE. How many people are reading this thread right now. A reader
 *      seeing "6 reading" knows the discussion is live, which is the single
 *      cheapest signal that a page is worth staying on.
 *   2. FAN-OUT. When someone comments, everyone already on the page sees it
 *      without refreshing.
 *
 * Persistence is the Worker's job (D1); this is purely realtime relay, mirroring
 * GroupRoom. Uses the hibernation API so an idle thread costs nothing — which
 * matters here far more than in group chat, because there is one room per story
 * and most stories are idle most of the time.
 *
 * Everything this powers is progressive enhancement: the page is fully rendered
 * and fully readable before any socket opens, and stays correct if none ever does.
 */
export class NewsRoom {
  constructor(private state: DurableObjectState) {}

  private broadcast(payload: unknown): void {
    const body = JSON.stringify(payload);
    for (const ws of this.state.getWebSockets()) {
      try { (ws as any).send(body); } catch { /* dropped socket */ }
    }
  }

  private announcePresence(): void {
    this.broadcast({ type: "presence", readers: this.state.getWebSockets().length });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.endsWith("/ws")) {
      const pair = new (globalThis as any).WebSocketPair();
      const client = pair[0] as any;
      const server = pair[1] as any;
      this.state.acceptWebSocket(server);
      // Tell the newcomer (and everyone else) the new count. Deferred a tick so
      // this socket is included in getWebSockets().
      this.announcePresence();
      return new Response(null, { status: 101, webSocket: client } as any);
    }

    if (url.pathname.endsWith("/comment")) {
      const body = await req.text();
      try { this.broadcast({ type: "comment", ...JSON.parse(body) }); }
      catch { /* malformed payload — never take the room down for it */ }
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }

  webSocketMessage(ws: any, message: any): void {
    if (message === "ping") {
      try { ws.send(JSON.stringify({ type: "pong", readers: this.state.getWebSockets().length })); } catch { /* ignore */ }
    }
  }

  webSocketClose(ws: any): void {
    try { ws.close(); } catch { /* ignore */ }
    this.announcePresence();
  }

  webSocketError(ws: any): void {
    try { ws.close(); } catch { /* ignore */ }
    this.announcePresence();
  }
}
