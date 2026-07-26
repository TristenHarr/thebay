/// <reference lib="webworker" />
/**
 * The walking router, in a real Web Worker.
 *
 * The routing core (src/core/nav) is pure and synchronous precisely so it can run
 * here without ceremony: the graph arrives once as a transferred ArrayBuffer,
 * `decodeWalkGraph` makes typed-array VIEWS over it (zero copy, zero parsing),
 * and every query is a synchronous bidirectional A*. A Bay-wide graph query can
 * settle hundreds of thousands of nodes — on the UI thread that is a dropped
 * frame budget; here it is invisible.
 *
 * Message protocol is deliberately tiny and request-id'd, because the UI fires a
 * new route on every toggle of "avoid hills" and stale replies must be droppable.
 */
import { decodeWalkGraph } from "../../../../src/core/nav/format";
import { buildNodeIndex, nearestNode, type NodeIndex } from "../../../../src/core/nav/spatial";
import { createScratch, route, type RouterScratch, type WalkRoute } from "../../../../src/core/nav/router";
import type { WalkGraph } from "../../../../src/core/nav/graph";

export interface LatLng { lat: number; lng: number }

export type RouterRequest =
  | { type: "load"; buffer: ArrayBuffer }
  | { type: "route"; id: number; from: LatLng; to: LatLng; avoidHills?: boolean; avoidStairs?: boolean; maxSettled?: number };

export type RouterResponse =
  | { type: "ready"; nodeCount: number; edgeCount: number; streetNames: number; bytes: number }
  | { type: "error"; id?: number; message: string }
  | { type: "result"; id: number; route: WalkRoute | null; snappedFrom: LatLng | null; snappedTo: LatLng | null };

let graph: WalkGraph | null = null;
let index: NodeIndex | null = null;
let scratch: RouterScratch | null = null;

const post = (msg: RouterResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);

self.onmessage = (ev: MessageEvent<RouterRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === "load") {
      graph = decodeWalkGraph(msg.buffer);
      // Built once: a per-query linear scan for the nearest node would dominate
      // the routing time on a graph this size.
      index = buildNodeIndex(graph);
      scratch = createScratch(graph);
      post({ type: "ready", nodeCount: graph.nodeCount, edgeCount: graph.edgeCount, streetNames: graph.nameDict.length, bytes: msg.buffer.byteLength });
      return;
    }
    if (msg.type === "route") {
      if (!graph) { post({ type: "error", id: msg.id, message: "no walking graph loaded" }); return; }
      const a = nearestNode(graph, msg.from.lat, msg.from.lng, { index, maxMetres: 3000 });
      const b = nearestNode(graph, msg.to.lat, msg.to.lng, { index, maxMetres: 3000 });
      if (a < 0 || b < 0) {
        post({ type: "error", id: msg.id, message: a < 0 ? "no footpath near your start point" : "no footpath near that destination" });
        return;
      }
      const r = route(graph, a, b, {
        avoidHills: msg.avoidHills,
        avoidStairs: msg.avoidStairs,
        maxSettled: msg.maxSettled ?? 2_000_000,
        scratch: scratch ?? undefined,
      });
      const snap = (i: number): LatLng => ({ lat: graph!.coords[2 * i]! / 1e7, lng: graph!.coords[2 * i + 1]! / 1e7 });
      post({ type: "result", id: msg.id, route: r, snappedFrom: snap(a), snappedTo: snap(b) });
    }
  } catch (e) {
    post({ type: "error", id: "id" in msg ? msg.id : undefined, message: e instanceof Error ? e.message : String(e) });
  }
};
