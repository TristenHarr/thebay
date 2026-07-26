import { useCallback, useEffect, useRef, useState } from "react";
import { openInstalledFile } from "../../offline/opfs";
import type { LatLng, RouterRequest, RouterResponse } from "./router.worker";
import type { WalkRoute } from "../../../../src/core/nav/router";

export type RouterStatus = "idle" | "downloading" | "indexing" | "ready" | "unavailable" | "error";

export interface RouterInfo { nodeCount: number; edgeCount: number; streetNames: number; bytes: number }
export interface Solved { route: WalkRoute | null; snappedFrom: LatLng | null; snappedTo: LatLng | null }
export interface SolveOptions { avoidHills?: boolean; avoidStairs?: boolean }

export interface WalkGraphPack { id: string; url: string; bytes: number }

/**
 * Owns the routing Web Worker and the walking-graph pack.
 *
 * Load order matters and is the whole offline story: if the pack is already
 * installed in OPFS we read it off disk (works with the radio off), otherwise we
 * pull it once over HTTP. Either way the ArrayBuffer is TRANSFERRED to the worker
 * — not copied — so a multi-megabyte graph costs one allocation, and the main
 * thread never holds a second copy.
 */
export function useWalkRouter(pack: WalkGraphPack | null) {
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef(new Map<number, { resolve: (s: Solved) => void; reject: (e: Error) => void }>());
  const seqRef = useRef(0);
  const loadedRef = useRef<string | null>(null);
  const [status, setStatus] = useState<RouterStatus>("idle");
  const [info, setInfo] = useState<RouterInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<"offline" | "network" | null>(null);

  // One worker for the lifetime of the screen.
  useEffect(() => {
    const worker = new Worker(new URL("./router.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (ev: MessageEvent<RouterResponse>) => {
      const msg = ev.data;
      if (msg.type === "ready") { setInfo({ nodeCount: msg.nodeCount, edgeCount: msg.edgeCount, streetNames: msg.streetNames, bytes: msg.bytes }); setStatus("ready"); return; }
      if (msg.type === "result") { pendingRef.current.get(msg.id)?.resolve({ route: msg.route, snappedFrom: msg.snappedFrom, snappedTo: msg.snappedTo }); pendingRef.current.delete(msg.id); return; }
      if (msg.type === "error") {
        if (msg.id !== undefined) { pendingRef.current.get(msg.id)?.reject(new Error(msg.message)); pendingRef.current.delete(msg.id); }
        else { setError(msg.message); setStatus("error"); }
      }
    };
    worker.onerror = (e) => { setError(e.message || "routing worker failed"); setStatus("error"); };
    return () => {
      worker.terminate();
      workerRef.current = null;
      for (const p of pendingRef.current.values()) p.reject(new Error("router closed"));
      pendingRef.current.clear();
    };
  }, []);

  // Load (or reload) the pack whenever it changes.
  useEffect(() => {
    if (!pack) { setStatus(pack === null ? "unavailable" : "idle"); return; }
    if (loadedRef.current === pack.id) return;
    let cancelled = false;
    (async () => {
      try {
        setError(null);
        const local = await openInstalledFile(pack.id);
        let buffer: ArrayBuffer;
        if (local && local.size === pack.bytes) {
          setStatus("indexing");
          setSource("offline");
          buffer = await local.arrayBuffer();
        } else {
          setStatus("downloading");
          setSource("network");
          const res = await fetch(pack.url);
          if (!res.ok) throw new Error(`walking graph unavailable (HTTP ${res.status})`);
          buffer = await res.arrayBuffer();
          setStatus("indexing");
        }
        if (cancelled || !workerRef.current) return;
        loadedRef.current = pack.id;
        const msg: RouterRequest = { type: "load", buffer };
        workerRef.current.postMessage(msg, [buffer]);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    })();
    return () => { cancelled = true; };
  }, [pack]);

  const solve = useCallback((from: LatLng, to: LatLng, opts: SolveOptions = {}): Promise<Solved> => {
    const worker = workerRef.current;
    if (!worker) return Promise.reject(new Error("router not started"));
    const id = ++seqRef.current;
    return new Promise<Solved>((resolve, reject) => {
      pendingRef.current.set(id, { resolve, reject });
      const msg: RouterRequest = { type: "route", id, from, to, avoidHills: opts.avoidHills, avoidStairs: opts.avoidStairs };
      worker.postMessage(msg);
    });
  }, []);

  return { status, info, error, source, solve };
}
