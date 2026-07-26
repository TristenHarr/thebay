import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useGetNetworkGraphQuery } from "../../api";
import { Spinner, PageHeader, EmptyState } from "../../ui/kit";

type Node = { id: string; name: string; handle?: string; me?: boolean; x: number; y: number; vx: number; vy: number };
type Edge = { a: string; b: string };

/**
 * Interactive founder graph — a force-directed layout of you + your connections,
 * rendered on a canvas. Nodes repel, edges pull, everything drifts toward centre.
 * Drag a node to reposition; hover to highlight its neighbourhood; click to open a
 * profile. Deliberately hacker-flavoured: monospace labels, faint grid, glowing you.
 */
export function NetworkGraph() {
  const { data, isLoading } = useGetNetworkGraphQuery();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nav = useNavigate();
  const [hover, setHover] = useState<string | null>(null);
  const hoverRef = useRef<string | null>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);

  /**
   * Build the simulation model, seeding positions by CONNECTIVITY rather than by array index.
   *
   * The old seeding placed nodes on one ring in `data.nodes` order, which is the order the SQL
   * happened to return. That is uncorrelated with who is connected to whom, so the sim starts
   * from a maximally-crossed state and has to untangle it — and with `alpha *= 0.994` flooring
   * at 0.02 (~640 frames, ~11s) it COOLS BEFORE IT UNTANGLES. The user sees a permanent knot
   * and concludes the graph is broken. It was the first visible symptom, well before the O(n²)
   * repulsion became a performance problem.
   *
   * Seeding neighbours near each other instead means the sim starts close to a solution and
   * only has to relax. High-degree nodes go on an inner ring (hubs belong in the middle), and
   * each node is nudged toward the mean angle of its already-placed neighbours.
   */
  const model = useMemo(() => {
    const raw = data?.nodes || [];
    const rawEdges = (data?.edges || []) as Array<{ a: string; b: string }>;

    const degree = new Map<string, number>();
    for (const e of rawEdges) {
      degree.set(e.a, (degree.get(e.a) || 0) + 1);
      degree.set(e.b, (degree.get(e.b) || 0) + 1);
    }
    const adj = new Map<string, Set<string>>();
    for (const e of rawEdges) {
      (adj.get(e.a) || adj.set(e.a, new Set()).get(e.a)!).add(e.b);
      (adj.get(e.b) || adj.set(e.b, new Set()).get(e.b)!).add(e.a);
    }

    // Most-connected first, so hubs are placed before the nodes that hang off them.
    const order = [...raw].sort((x: any, y: any) => (y.me ? 1 : 0) - (x.me ? 1 : 0) || (degree.get(y.id) || 0) - (degree.get(x.id) || 0));
    const maxDeg = Math.max(1, ...order.map((d: any) => degree.get(d.id) || 0));
    const angle = new Map<string, number>();
    const nodes: Node[] = order.map((d: any, i: number) => {
      const placed = [...(adj.get(d.id) || [])].map((nb) => angle.get(nb)).filter((a): a is number => a !== undefined);
      // Sit near your neighbours if any are down already; otherwise take a golden-angle slot,
      // which spreads the unconstrained nodes evenly instead of clumping them.
      const a = placed.length
        ? Math.atan2(placed.reduce((s, x) => s + Math.sin(x), 0) / placed.length, placed.reduce((s, x) => s + Math.cos(x), 0) / placed.length) +
          (i % 2 ? 0.35 : -0.35)
        : i * 2.399963;
      angle.set(d.id, a);
      // Hubs inward, leaves outward.
      const r = d.me ? 0 : 200 - 110 * ((degree.get(d.id) || 0) / maxDeg);
      return { id: d.id, name: d.name || d.handle || "—", handle: d.handle, me: d.me, x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0 };
    });

    const idx = new Map(nodes.map((nd) => [nd.id, nd]));
    const edges: Edge[] = rawEdges.filter((e: any) => idx.has(e.a) && idx.has(e.b)) as Edge[];
    return { nodes, edges, idx, degree, adj };
  }, [data]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || model.nodes.length === 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let raf = 0;
    let alpha = 1; // cooling factor

    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue("--accent").trim() || "#6366f1";
    const gold = css.getPropertyValue("--gold").trim() || "#eab308";
    const muted = css.getPropertyValue("--muted").trim() || "#8b8b9a";

    function resize() {
      const w = canvas!.clientWidth, h = canvas!.clientHeight;
      canvas!.width = w * dpr; canvas!.height = h * dpr;
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    function tick() {
      const w = canvas!.width / dpr, h = canvas!.height / dpr;
      const cx = w / 2, cy = h / 2;
      const N = model.nodes;
      // repulsion (O(n²) — fine for an ego network)
      for (let i = 0; i < N.length; i++) {
        for (let j = i + 1; j < N.length; j++) {
          const a = N[i]!, b = N[j]!;
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy || 0.01;
          const f = (2600 * alpha) / d2;
          const d = Math.sqrt(d2);
          const ux = dx / d, uy = dy / d;
          a.vx += ux * f; a.vy += uy * f; b.vx -= ux * f; b.vy -= uy * f;
        }
      }
      // spring attraction along edges
      for (const e of model.edges) {
        const a = model.idx.get(e.a)!, b = model.idx.get(e.b)!;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d - 90) * 0.015 * alpha;
        const ux = dx / d, uy = dy / d;
        a.vx += ux * f; a.vy += uy * f; b.vx -= ux * f; b.vy -= uy * f;
      }
      // gravity to centre + integrate
      for (const nd of N) {
        nd.vx += (0 - nd.x) * 0.004 * alpha;
        nd.vy += (0 - nd.y) * 0.004 * alpha;
        if (dragRef.current?.id === nd.id) { nd.vx = 0; nd.vy = 0; continue; }
        nd.vx *= 0.82; nd.vy *= 0.82;
        nd.x += nd.vx; nd.y += nd.vy;
      }
      alpha = Math.max(0.02, alpha * 0.994);

      // draw
      const ctx = canvas!.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(cx, cy);
      const hov = hoverRef.current;
      const near = hov ? model.adj.get(hov) : null;

      // edges
      for (const e of model.edges) {
        const a = model.idx.get(e.a)!, b = model.idx.get(e.b)!;
        const lit = hov && (e.a === hov || e.b === hov);
        ctx.strokeStyle = lit ? accent : "rgba(130,130,150,0.16)";
        ctx.lineWidth = lit ? 1.6 : 0.8;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      // nodes
      for (const nd of N) {
        const deg = model.degree.get(nd.id) || 0;
        const r = nd.me ? 11 : Math.min(10, 4 + deg * 0.8);
        const active = !hov || nd.id === hov || near?.has(nd.id);
        ctx.globalAlpha = active ? 1 : 0.28;
        if (nd.me) {
          ctx.shadowColor = gold; ctx.shadowBlur = 16;
          ctx.fillStyle = gold;
        } else {
          ctx.shadowColor = accent; ctx.shadowBlur = nd.id === hov ? 14 : 0;
          ctx.fillStyle = nd.id === hov ? accent : "#c7c7d1";
        }
        ctx.beginPath(); ctx.arc(nd.x, nd.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
        if (nd.me || nd.id === hov || deg >= 3) {
          ctx.globalAlpha = active ? 1 : 0.28;
          ctx.fillStyle = nd.me ? gold : muted;
          ctx.font = `${nd.me ? 600 : 400} 11px ui-monospace, monospace`;
          ctx.textAlign = "center";
          ctx.fillText(nd.me ? `${nd.name} (you)` : nd.name, nd.x, nd.y - r - 5);
        }
      }
      ctx.restore();
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [model]);

  // pointer → node hit-testing in model space
  function toModel(ev: React.PointerEvent) {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    return { x: ev.clientX - rect.left - rect.width / 2, y: ev.clientY - rect.top - rect.height / 2 };
  }
  function pick(x: number, y: number): Node | null {
    let best: Node | null = null, bd = 18 * 18;
    for (const nd of model.nodes) { const dx = nd.x - x, dy = nd.y - y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = nd; } }
    return best;
  }

  if (isLoading) return <Spinner />;
  if (!model.nodes.length) return (
    <div data-testid="network-graph">
      <PageHeader title="Network graph" sub="Your founder graph, visualized." />
      <EmptyState title="No connections yet" hint="Add friends and accept intros — your graph grows as you connect." />
    </div>
  );

  return (
    <div data-testid="network-graph">
      <PageHeader title="Network graph" sub={`${model.nodes.length} people · ${model.edges.length} connections · drag to explore`} />
      <div className="relative overflow-hidden rounded-xl border border-border bg-elev" style={{ height: "min(70vh, 560px)" }}>
        <div className="pointer-events-none absolute inset-0 opacity-[0.06]" style={{ backgroundImage: "linear-gradient(var(--border) 1px,transparent 1px),linear-gradient(90deg,var(--border) 1px,transparent 1px)", backgroundSize: "28px 28px" }} />
        <canvas
          ref={canvasRef}
          className="h-full w-full touch-none"
          onPointerMove={(ev) => {
            const { x, y } = toModel(ev);
            if (dragRef.current) { const nd = model.idx.get(dragRef.current.id); if (nd) { nd.x = x - dragRef.current.dx; nd.y = y - dragRef.current.dy; nd.vx = 0; nd.vy = 0; } return; }
            const hit = pick(x, y); const id = hit?.id ?? null;
            hoverRef.current = id; setHover(id);
            canvasRef.current!.style.cursor = id ? "pointer" : "default";
          }}
          onPointerDown={(ev) => { const { x, y } = toModel(ev); const hit = pick(x, y); if (hit) { dragRef.current = { id: hit.id, dx: x - hit.x, dy: y - hit.y }; canvasRef.current!.setPointerCapture(ev.pointerId); } }}
          onPointerUp={(ev) => {
            const drag = dragRef.current; dragRef.current = null;
            const { x, y } = toModel(ev); const hit = pick(x, y);
            // treat as click (navigate) only if we didn't really move
            if (hit && drag && hit.id === drag.id && Math.abs(x - drag.dx - hit.x) < 4 && !hit.me && hit.handle) nav(`/u/${hit.handle}`);
          }}
          onPointerLeave={() => { hoverRef.current = null; setHover(null); dragRef.current = null; }}
        />
        {hover && (() => { const nd = model.idx.get(hover); if (!nd) return null; return (
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg border border-border bg-bg/90 px-3 py-2 text-sm backdrop-blur">
            <div className="font-semibold">{nd.name}{nd.me ? " · you" : ""}</div>
            <div className="font-mono text-xs text-muted">{model.degree.get(nd.id) || 0} connections{nd.handle && !nd.me ? " · click to open" : ""}</div>
          </div>
        ); })()}
      </div>
      <p className="mt-3 text-center text-xs text-muted">Node size = number of connections · gold = you · drag to rearrange, click a node to view their profile.</p>
    </div>
  );
}
