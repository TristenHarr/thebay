import type { DurableObjectState } from "@cloudflare/workers-types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * GroupRoom — one Durable Object per event group. Holds the live WebSocket
 * connections and relays messages to everyone in the room. Uses the hibernation
 * API (acceptWebSocket / getWebSockets) so idle rooms cost nothing. Message
 * *persistence* is done by the Worker route (D1); the DO is purely the realtime
 * fan-out, kept deliberately small.
 */
export class GroupRoom {
  constructor(private state: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Client opens a socket: /ws
    if (url.pathname.endsWith("/ws")) {
      const pair = new (globalThis as any).WebSocketPair();
      const client = pair[0] as any;
      const server = pair[1] as any;
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client } as any);
    }

    // Worker posts a persisted message here to fan out to all sockets: /broadcast
    if (url.pathname.endsWith("/broadcast")) {
      const body = await req.text();
      for (const ws of this.state.getWebSockets()) {
        try {
          (ws as any).send(body);
        } catch {
          /* dropped socket */
        }
      }
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }

  // Clients are receive-only for authoritative messages (posted via the API);
  // a ping keeps the socket warm.
  webSocketMessage(ws: any, message: any): void {
    if (message === "ping") {
      try {
        ws.send("pong");
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
