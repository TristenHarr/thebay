import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useGetEventsQuery } from "../api";
import { allDestinations } from "../app/nav";

type Cmd = { id: string; label: string; hint?: string; kbd?: string; run: () => void; group: string };

/**
 * ⌘K command palette. Keyboard-first navigation and quick actions — open with
 * ⌘K / Ctrl-K (or "/"), type to fuzzy-filter, ↑/↓ to move, ↵ to run, Esc to
 * close. Also jumps straight to any event by title. Built for people who'd
 * rather never touch the mouse.
 */
export function CommandPalette() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { data: eventsData } = useGetEventsQuery("?limit=3000", { skip: !open });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !/input|textarea/i.test((e.target as HTMLElement)?.tagName))) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") setOpen(false);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-command-palette", onOpen);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("open-command-palette", onOpen); };
  }, []);

  useEffect(() => { if (open) { setQ(""); setI(0); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);

  const go = (path: string) => () => { nav(path); setOpen(false); };
  const NAV: Cmd[] = useMemo(() => [
    // Every destination comes from the nav config — the palette cannot fall behind
    // the app, because there is no second list to update. The hint carries the
    // section name, which the filter also matches on.
    ...allDestinations().map((d) => ({
      id: `go:${d.to}`,
      label: d.label,
      hint: d.section,
      group: "Go",
      run: go(d.to),
    })),
    // Not a destination: the board floats over whatever page you're on rather than
    // being one, so it has no place in the section tabs.
    { id: "board", label: "Shadows — the live board", hint: "City", group: "Go", run: go("/board") },
    { id: "pokedex", label: "Founder Pokédex — catch people", hint: "Game", group: "Go", run: go("/pokedex") },
    { id: "crawls", label: "Founder Crawls — plan a route", hint: "Game", group: "Go", run: go("/crawls") },
    { id: "newgoal", label: "Add a goal", group: "Action", run: go("/goals") },
    // Cross-domain: a full navigation through OUR handoff endpoint (relative), so
    // the reader lands on thebay.news already signed in.
    { id: "news", label: "thebay.news — Bay Area tech news", hint: "↗", group: "Go",
      run: () => { window.location.href = "/auth/handoff/start?next=%2F"; } },
    { id: "news-submit", label: "Submit a story to thebay.news", hint: "↗", group: "Action",
      run: () => { window.location.href = "/auth/handoff/start?next=%2Fsubmit"; } },
  ], []); // go() closes over nav; stable enough for this session

  const eventCmds: Cmd[] = useMemo(() => {
    if (!q.trim() || !eventsData?.events) return [];
    const needle = q.toLowerCase();
    return eventsData.events
      .filter((e: any) => e.title?.toLowerCase().includes(needle))
      .slice(0, 6)
      .map((e: any) => ({ id: `ev-${e.id}`, label: e.title, hint: "event", group: "Events", run: () => { nav(`/event/${e.id}`); setOpen(false); } }));
  }, [q, eventsData, nav]);

  const filtered = useMemo(() => {
    // Match the hint too, so the section name is a search term: "people" finds
    // Friends/Groups/Intros, "signal" finds Impact/Companies.
    const base = q.trim()
      ? NAV.filter((c) => `${c.label} ${c.hint ?? ""}`.toLowerCase().includes(q.toLowerCase()))
      : NAV;
    return [...base, ...eventCmds];
  }, [q, NAV, eventCmds]);

  useEffect(() => { setI(0); }, [q]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${i}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [i]);

  if (!open) return null;
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setI((v) => Math.min(filtered.length - 1, v + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setI((v) => Math.max(0, v - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); filtered[i]?.run(); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[12vh]" onClick={() => setOpen(false)} role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-elev shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Jump to… (type a page or event)"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted"
          aria-label="Search commands"
        />
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-1.5">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-sm text-muted">No matches</div>}
          {filtered.map((c, idx) => (
            <button
              key={c.id}
              data-idx={idx}
              onMouseEnter={() => setI(idx)}
              onClick={() => c.run()}
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${idx === i ? "bg-accent text-accent-ink" : "text-text"}`}
            >
              <span className="flex-1 truncate">{c.label}</span>
              {c.hint && <span className={`text-xs ${idx === i ? "opacity-80" : "text-muted"}`}>{c.hint}</span>}
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${idx === i ? "bg-white/20" : "bg-surface text-muted"}`}>{c.group}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-[11px] text-muted">
          <span>↑↓ navigate · ↵ open · esc close</span>
          <span className="font-mono">⌘K</span>
        </div>
      </div>
    </div>
  );
}
