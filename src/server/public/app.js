"use strict";
/*
 * Eventers dashboard — loads ALL events once and filters entirely client-side
 * (instant, no round-trips). Works two ways:
 *   • static site  → fetches ./events.json (data + metadata baked in)
 *   • local server → falls back to the /api endpoints
 * Star/hide persist in localStorage so it needs no backend when hosted static.
 */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const el = (t, c, txt) => {
    const n = document.createElement(t);
    if (c) n.className = c;
    if (txt != null) n.textContent = txt;
    return n;
  };
  const LS = {
    get(k) { try { return new Set(JSON.parse(localStorage.getItem(k) || "[]")); } catch { return new Set(); } },
    set(k, s) { try { localStorage.setItem(k, JSON.stringify([...s])); } catch {} },
  };
  /* ---------- curator layer ----------
   * Some sources are human-curated lists (e.g. Kyosuke Togami's Airtable). Those
   * events carry `curatedBy: [{name,url}]`. We surface curation as its own credited
   * layer — a ✦ badge + a spotlight + a "curated only" filter — always linking back
   * to the curator's own list. `curatorsOf` is the single source of truth for
   * "is this a curated event"; everything else derives from it. */
  const curatorsOf = (e) => (e && e.curatedBy && e.curatedBy.length ? e.curatedBy : null);
  const curatedCount = () => ALL.reduce((n, e) => n + (curatorsOf(e) ? 1 : 0), 0);

  // sidebar boolean filters: [checkbox id, state key]
  const TOGGLES = [["curated", "curatedOnly"], ["free", "free"], ["starred", "starred"], ["includeHidden", "includeHidden"]];
  const syncToggles = () => { for (const [id, key] of TOGGLES) { const b = $("#" + id); if (b) b.checked = state[key]; } };

  // Readable text color for a solid badge background.
  function textOn(hex) {
    const h = (hex || "").replace("#", "");
    if (h.length < 6) return "#0a0d12";
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.62 ? "#0a0d12" : "#ffffff";
  }
  function initTheme() {
    const root = document.documentElement;
    const btn = $("#theme");
    const cur = () => root.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const saved = localStorage.getItem("ev_theme");
    if (saved) root.setAttribute("data-theme", saved);
    const paint = () => { if (btn) btn.textContent = cur() === "dark" ? "☀" : "☾"; };
    paint();
    if (btn) btn.addEventListener("click", () => { const n = cur() === "dark" ? "light" : "dark"; root.setAttribute("data-theme", n); localStorage.setItem("ev_theme", n); paint(); });
  }

  const state = {
    q: "", sort: "soonest",
    cats: new Set(), cities: new Set(), sources: new Set(),
    free: false, minScore: 0, starred: false, includeHidden: false, curatedOnly: false,
    date: "30d", from: "", to: "",
    timeOfDay: "any", // any | morning | afternoon | evening
    trip: null, // { from, to } when a trip is planned
    pick: null, // Set of ids when viewing a shared itinerary link
  };
  let ALL = [];
  const meta = { cat: {}, city: {}, srcLabel: {}, sources: [], curators: [], archive: [], archiveTotal: 0, generatedAt: null, live: false };
  let stars = LS.get("ev_stars");
  let hidden = LS.get("ev_hidden");

  /* ---------- data loading ---------- */
  async function boot() {
    let data = null;
    try {
      const r = await fetch("./events.json", { cache: "no-store" });
      if (r.ok) data = await r.json();
    } catch {}
    if (data && Array.isArray(data.events)) {
      ALL = data.events;
      (data.categories || []).forEach((c) => (meta.cat[c.id] = c));
      (data.cities || []).forEach((c) => (meta.city[c.id] = c.label));
      meta.sources = data.sources || [];
      meta.curators = data.curators || [];
      meta.archive = data.curatedArchive || [];
      meta.archiveTotal = data.curatedArchiveTotal || (data.curatedArchive || []).length;
      meta.generatedAt = data.generatedAt;
    } else {
      meta.live = true;
      const [ev, cats, cities, srcs] = await Promise.all([
        fetch("/api/events?past=1&includeHidden=1&limit=100000").then((r) => r.json()),
        fetch("/api/categories").then((r) => r.json()),
        fetch("/api/cities").then((r) => r.json()),
        fetch("/api/sources").then((r) => r.json()).catch(() => []),
      ]);
      ALL = ev.events || [];
      cats.forEach((c) => (meta.cat[c.id] = c));
      cities.forEach((c) => (meta.city[c.id] = c.label));
      meta.sources = srcs;
    }
    meta.sources.forEach((s) => (meta.srcLabel[s.id] = s.id));
    parseHash();
    loadTrip();
    bindUI();
    renderStatic();
    render();
  }

  /* ---------- date helpers ---------- */
  function fmt(iso, tz, o) {
    try { return new Intl.DateTimeFormat("en-US", { timeZone: tz, ...o }).format(new Date(iso)); }
    catch { return new Intl.DateTimeFormat("en-US", o).format(new Date(iso)); }
  }
  const dayKey = (iso, tz) => fmt(iso, tz, { year: "numeric", month: "2-digit", day: "2-digit" });
  const dayLabel = (iso, tz) => fmt(iso, tz, { weekday: "short", month: "short", day: "numeric" });
  const timeLabel = (iso, tz) => fmt(iso, tz, { hour: "numeric", minute: "2-digit" });
  const eventHour = (iso, tz) => { try { return parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date(iso)), 10) % 24; } catch { return new Date(iso).getHours(); } };

  function dateWindow() {
    const now = new Date();
    const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
    const d = (n) => { const x = new Date(startOfToday); x.setDate(x.getDate() + n); return x; };
    switch (state.date) {
      case "today": return [startOfToday, d(1)];
      case "weekend": {
        // upcoming Sat 00:00 → Mon 00:00
        const dow = now.getDay();
        const sat = d((6 - dow + 7) % 7);
        const mon = new Date(sat); mon.setDate(mon.getDate() + 2);
        return [sat, mon];
      }
      case "7d": return [new Date(now.getTime() - 6 * 3600e3), d(7)];
      case "30d": return [new Date(now.getTime() - 6 * 3600e3), d(30)];
      case "all": return [null, null];
      case "custom": return [state.from ? new Date(state.from) : null, state.to ? new Date(state.to + "T23:59:59") : null];
      default: return [new Date(now.getTime() - 6 * 3600e3), null]; // upcoming
    }
  }

  /* ---------- filtering ---------- */
  function baseFilter(e) {
    if (state.pick && !state.pick.has(e.id)) return false;
    if (hidden.has(e.id) && !state.includeHidden) return false;
    if (state.curatedOnly && !curatorsOf(e)) return false;
    const [from, to] = dateWindow();
    const t = new Date(e.startUtc).getTime();
    if (from && t < from.getTime()) return false;
    if (to && t >= to.getTime()) return false;
    if (state.timeOfDay !== "any" && timeLabel(e.startUtc, e.timezone) !== "12:00 AM") {
      const h = eventHour(e.startUtc, e.timezone);
      if (state.timeOfDay === "morning" && !(h < 12)) return false;
      if (state.timeOfDay === "afternoon" && !(h >= 12 && h < 17)) return false;
      if (state.timeOfDay === "evening" && h < 17) return false;
    }
    if (state.free && e.isFree !== true) return false;
    if (state.minScore > 0 && !(e.interestScore >= state.minScore)) return false;
    if (state.starred && !stars.has(e.id)) return false;
    if (state.q) {
      const hay = (e.title + " " + (e.organizer || "") + " " + (e.venueName || "") + " " + (e.description || "")).toLowerCase();
      if (!state.q.split(/\s+/).every((tok) => hay.includes(tok))) return false;
    }
    return true;
  }
  const matchMulti = (e) =>
    (!state.cats.size || (e.categories || []).some((c) => state.cats.has(c))) &&
    (!state.cities.size || state.cities.has(e.city)) &&
    (!state.sources.size || (e.sources || []).some((s) => state.sources.has(s.sourceId)));

  function filtered() {
    const list = ALL.filter((e) => baseFilter(e) && matchMulti(e));
    if (state.sort === "interesting") list.sort((a, b) => (b.interestScore ?? -1) - (a.interestScore ?? -1) || a.startUtc.localeCompare(b.startUtc));
    else if (state.sort === "newest") list.sort((a, b) => (b.firstSeenAt || "").localeCompare(a.firstSeenAt || "") || a.startUtc.localeCompare(b.startUtc));
    else list.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
    return list;
  }

  /* ---------- facet counts (respect base filter, ignore own dimension) ---------- */
  function facetCounts(dim) {
    const counts = new Map();
    for (const e of ALL) {
      if (!baseFilter(e)) continue;
      // apply the OTHER two multi-dims
      if (dim !== "cats" && state.cats.size && !(e.categories || []).some((c) => state.cats.has(c))) continue;
      if (dim !== "cities" && state.cities.size && !state.cities.has(e.city)) continue;
      if (dim !== "sources" && state.sources.size && !(e.sources || []).some((s) => state.sources.has(s.sourceId))) continue;
      const vals = dim === "cats" ? e.categories || [] : dim === "cities" ? [e.city] : [...new Set((e.sources || []).map((s) => s.sourceId))];
      for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
    }
    return counts;
  }

  /* ---------- rendering ---------- */
  function chipRow(id, dim, labelOf, colorOf) {
    const box = $(id); box.innerHTML = "";
    const counts = facetCounts(dim);
    const values = new Set([...counts.keys(), ...state[dim]]);
    const sorted = [...values].sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0));
    for (const v of sorted) {
      if ((counts.get(v) || 0) === 0 && !state[dim].has(v)) continue;
      const chip = el("div", "chip" + (state[dim].has(v) ? " active" : ""));
      if (colorOf) { const dot = el("span", "cdot"); dot.style.background = colorOf(v) || "#8d99ae"; chip.appendChild(dot); }
      chip.appendChild(el("span", "clabel", labelOf(v)));
      chip.appendChild(el("span", "ccount", String(counts.get(v) || 0)));
      chip.addEventListener("click", () => { state[dim].has(v) ? state[dim].delete(v) : state[dim].add(v); render(); });
      box.appendChild(chip);
    }
  }

  function renderStatic() {
    // sources health
    const hb = $("#sources-health"); hb.innerHTML = "";
    for (const s of meta.sources) {
      const chip = el("span", "health-chip");
      const dot = el("span", "dot" + (s.lastStatus === "ok" ? " ok" : s.lastStatus === "error" ? " error" : ""));
      chip.appendChild(dot);
      chip.appendChild(el("span", null, s.id + (s.enabled === false ? " (off)" : "")));
      hb.appendChild(chip);
    }
    if (meta.generatedAt) $("#updated").textContent = "updated " + rel(meta.generatedAt);
    if (!meta.live) $("#rescrape").style.display = "none";
    const fc = $("#foot-count"); if (fc) fc.textContent = ALL.length.toLocaleString() + " events";
    renderCurators();
  }

  /* Curator credit + spotlight + linkback. Built once on load: the footer always
   * credits every curator, the spotlight elevates their list and links back, and
   * the sidebar "curated only" filter only appears when there ARE curated events
   * to show (so it never looks broken when a curator's list has nothing upcoming). */
  function renderCurators() {
    const curators = meta.curators || [];
    const n = curatedCount();

    // footer credit — always, even when a curator's picks are all past
    const foot = $("#foot-curators");
    if (foot) {
      foot.innerHTML = "";
      if (curators.length) {
        foot.appendChild(el("span", "foot-star", "✦"));
        foot.appendChild(document.createTextNode(" Featuring human-curated picks from "));
        curators.forEach((c, i) => {
          const a = c.url ? el("a", null, c.name) : el("span", null, c.name);
          if (c.url) { a.href = c.url; a.target = "_blank"; a.rel = "noopener"; }
          foot.appendChild(a);
          if (i < curators.length - 1) foot.appendChild(document.createTextNode(i === curators.length - 2 ? " & " : ", "));
        });
        foot.appendChild(document.createTextNode(" — the events they think are worth your time."));
      }
    }

    // spotlight — a credited, linked-back callout above the feed
    const spot = $("#curator-spotlight");
    if (spot) {
      spot.innerHTML = "";
      if (curators.length) {
        spot.appendChild(el("div", "cs-mark", "✦"));
        const body = el("div", "cs-body");
        const title = el("div", "cs-title");
        title.appendChild(document.createTextNode("Curated by "));
        curators.forEach((c, i) => {
          const a = c.url ? el("a", null, c.name) : el("span", null, c.name);
          if (c.url) { a.href = c.url; a.target = "_blank"; a.rel = "noopener"; }
          title.appendChild(a);
          if (i < curators.length - 1) title.appendChild(document.createTextNode(i === curators.length - 2 ? " & " : ", "));
        });
        body.appendChild(title);
        if (curators[0] && curators[0].blurb) body.appendChild(el("div", "cs-blurb", curators[0].blurb));
        const meta2 = el("div", "cs-meta");
        const arch = meta.archive || [];
        // upcoming picks → jump straight to them in the feed (primary action)
        if (n > 0) {
          const btn = el("button", "cs-cta", "✦ Show these " + n + " upcoming picks");
          btn.addEventListener("click", () => { state.curatedOnly = true; syncToggles(); render(); });
          meta2.appendChild(btn);
        }
        // recent (past) picks → expandable archive (secondary action, always offered)
        if (arch.length) {
          const btn = el("button", "cs-cta" + (n > 0 ? " alt" : ""), "✦ Browse " + arch.length + " recent picks");
          btn.addEventListener("click", () => toggleArchive(btn));
          meta2.appendChild(btn);
        }
        if (n === 0 && !arch.length) {
          meta2.appendChild(el("span", "cs-note", "No upcoming picks on their list right now — open it for what's next."));
        }
        // primary linkback — the durable home of their curation (their newsletter)
        const c0 = curators[0] || {};
        const home = c0.substack || c0.url;
        if (home) {
          const first = (c0.name || "").split(" ")[0];
          const link = el("a", "cs-link", (c0.substack ? "📰 " + first + "'s newsletter →" : "Open " + first + "'s list →"));
          link.href = home; link.target = "_blank"; link.rel = "noopener";
          meta2.appendChild(link);
        }
        body.appendChild(meta2);
        spot.appendChild(body);
        spot.hidden = false;
      } else {
        spot.hidden = true;
      }
    }

    renderCuratorArchive();

    // sidebar "curated only" toggle — only meaningful when upcoming picks exist
    const tgl = $("#curated-toggle");
    if (tgl) tgl.hidden = n === 0;
  }

  /* Curator archive — a curator's recent (past) picks, listed compactly and clearly
   * labeled as already-happened. Each row links out to the real event; the spotlight
   * links back to the curator's list. Collapsed until the visitor expands it. */
  function toggleArchive(btn) {
    const panel = $("#curator-archive");
    if (!panel) return;
    const open = panel.hidden;
    panel.hidden = !open;
    if (btn) btn.classList.toggle("open", open);
  }
  function renderCuratorArchive() {
    const panel = $("#curator-archive");
    if (!panel) return;
    const arch = meta.archive || [];
    panel.innerHTML = "";
    panel.hidden = true;
    if (!arch.length) return;
    const head = el("div", "ca-head");
    head.appendChild(el("span", "ca-tag", "Archive"));
    const total = meta.archiveTotal || arch.length;
    const note = total > arch.length
      ? "showing " + arch.length + " of " + total.toLocaleString() + " past picks · already happened"
      : arch.length + " recent picks · these events have already happened";
    head.appendChild(el("span", "ca-note", note));
    const c0 = (meta.curators || [])[0] || {};
    const home = c0.substack || c0.url;
    if (home) {
      const more = el("a", "ca-more", "full history →");
      more.href = home; more.target = "_blank"; more.rel = "noopener";
      head.appendChild(more);
    }
    panel.appendChild(head);
    const listBox = el("div", "ca-list");
    for (const e of arch) {
      const row = e.url ? el("a", "ca-row") : el("div", "ca-row");
      if (e.url) { row.href = e.url; row.target = "_blank"; row.rel = "noopener"; }
      row.appendChild(el("span", "ca-date", fmt(e.startUtc, e.timezone, { month: "short", day: "numeric" })));
      row.appendChild(el("span", "ca-title", e.title));
      row.appendChild(el("span", "ca-venue", [e.venueName, cityLabel(e.city)].filter(Boolean).join(" · ")));
      listBox.appendChild(row);
    }
    panel.appendChild(listBox);
  }
  function rel(iso) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }

  function render() {
    writeHash();
    CONFLICTS = computeConflicts();
    chipRow("#f-categories", "cats", (v) => (meta.cat[v] && meta.cat[v].label) || v, (v) => meta.cat[v] && meta.cat[v].color);
    chipRow("#f-cities", "cities", (v) => meta.city[v] || v, null);
    chipRow("#f-sources", "sources", (v) => v, null);
    for (const b of $("#date-chips").children) b.classList.toggle("active", b.dataset.date === state.date);
    for (const b of $("#time-chips").children) b.classList.toggle("active", b.dataset.time === state.timeOfDay);
    for (const b of $("#sort").children) b.classList.toggle("active", b.dataset.sort === state.sort);

    const list = filtered();
    renderTripBanner(list.length);
    renderItinerary();
    $("#custom-dates").hidden = state.date !== "custom";
    const fromEl = $("#from"), toEl = $("#to");
    if (fromEl && fromEl.value !== (state.from || "")) fromEl.value = state.from || "";
    if (toEl && toEl.value !== (state.to || "")) toEl.value = state.to || "";
    const CAP = 600;
    const shown = list.slice(0, CAP);
    $("#summary").textContent = list.length > CAP
      ? `Showing ${CAP.toLocaleString()} of ${list.length.toLocaleString()} events — refine to narrow`
      : `${list.length.toLocaleString()} event${list.length === 1 ? "" : "s"}`;
    const box = $("#events"); box.innerHTML = "";
    const empty = $("#empty");
    empty.hidden = list.length > 0;
    if (list.length === 0) {
      // tailor the empty state — a curated-only view links back to the curator
      const cur = state.curatedOnly && (meta.curators || [])[0];
      empty.innerHTML = cur
        ? `<p>No upcoming curated picks match these filters.</p>` +
          (cur.url ? `<p class="muted">Browse <a href="${cur.url}" target="_blank" rel="noopener">${cur.name}'s full list</a> for what's coming next.</p>`
                   : `<p class="muted">${cur.name}'s picks are all past right now — check back soon.</p>`)
        : `<p>No events match these filters.</p><p class="muted">Try widening the date range or clearing a filter.</p>`;
    }

    if (state.sort !== "soonest") {
      for (const e of shown) box.appendChild(card(e));
    } else {
      const scheduleMode = state.starred || !!state.pick;
      let key = null, group = null;
      for (let i = 0; i < shown.length; i++) {
        const e = shown[i];
        const k = dayKey(e.startUtc, e.timezone);
        if (k !== key) {
          key = k;
          group = el("div", "day-group");
          const h = el("div", "day-header");
          h.appendChild(document.createTextNode(dayLabel(e.startUtc, e.timezone)));
          group.appendChild(h);
          box.appendChild(group);
        }
        group.appendChild(card(e));
        // Trip planner: show travel/gap/feasibility between consecutive same-day events.
        if (scheduleMode && i + 1 < shown.length) {
          const next = shown[i + 1];
          if (dayKey(next.startUtc, next.timezone) === k) {
            const conn = connectorRow(e, next);
            if (conn) group.appendChild(conn);
          }
        }
      }
    }
  }

  function card(e) {
    const c = el("div", "card");
    if (hidden.has(e.id)) c.classList.add("hidden-flag");
    if (stars.has(e.id)) c.classList.add("in-trip");
    if (CONFLICTS[e.id]) c.classList.add("has-conflict");
    if (curatorsOf(e)) c.classList.add("curated");
    const ts = timeLabel(e.startUtc, e.timezone);
    const te = e.endUtc ? timeLabel(e.endUtc, e.timezone) : null;
    const time = el("div", "time");
    if (ts === "12:00 AM" && (!te || te === "12:00 AM")) {
      time.appendChild(el("span", "allday", "All day"));
    } else {
      time.appendChild(document.createTextNode(ts));
      if (te) time.appendChild(el("small", null, "– " + te));
    }
    c.appendChild(time);

    const body = el("div", "body");
    const h = el("h4"); const a = el("a", null, e.title); a.href = e.url; a.target = "_blank"; a.rel = "noopener";
    h.appendChild(a); body.appendChild(h);
    const m = el("div", "meta");
    const place = [e.venueName, e.city && e.city !== "unknown" ? meta.city[e.city] || e.city : null].filter(Boolean).join(" · ");
    if (place) m.appendChild(el("span", null, "📍 " + place));
    if (e.organizer) m.appendChild(el("span", null, "👤 " + e.organizer));
    const st = [...new Set((e.sources || []).map((s) => s.sourceType))].join(", ");
    if (st) m.appendChild(el("span", "src-tag", st));
    body.appendChild(m);
    const badges = el("div", "badges");
    const cur = curatorsOf(e);
    if (cur) {
      const c0 = cur[0];
      const cb = c0.url ? el("a", "badge curated") : el("span", "badge curated");
      cb.textContent = "✦ " + c0.name;
      cb.title = "A curated pick by " + c0.name + " — open their list";
      if (c0.url) { cb.href = c0.url; cb.target = "_blank"; cb.rel = "noopener"; }
      badges.appendChild(cb);
    }
    for (const cat of e.categories || []) { const col = (meta.cat[cat] && meta.cat[cat].color) || "#8d99ae"; const b = el("span", "badge", (meta.cat[cat] && meta.cat[cat].label) || cat); b.style.background = col; b.style.color = textOn(col); badges.appendChild(b); }
    if (e.isFree === true) badges.appendChild(el("span", "badge free", "Free"));
    else if (e.priceText) badges.appendChild(el("span", "badge price", e.priceText));
    if (typeof e.interestScore === "number") badges.appendChild(el("span", "badge score", "★ " + e.interestScore));
    if (CONFLICTS[e.id] && CONFLICTS[e.id].length) { const w = el("span", "badge conflict", "⚠ time conflict"); w.title = "Overlaps with: " + CONFLICTS[e.id].join("; "); badges.appendChild(w); }
    body.appendChild(badges);
    const links = el("div", "card-links");
    const g = gmapsUrl(e);
    if (g) { const a = el("a", "cardlink", "📍 Directions"); a.href = g; a.target = "_blank"; a.rel = "noopener"; links.appendChild(a); }
    const cal = el("a", "cardlink", "📅 Add"); cal.href = gcalUrl(e); cal.target = "_blank"; cal.rel = "noopener"; links.appendChild(cal);
    const food = el("a", "cardlink", "🍽 Food nearby"); food.href = foodUrl(e); food.target = "_blank"; food.rel = "noopener"; links.appendChild(food);
    body.appendChild(links);
    c.appendChild(body);

    const actions = el("div", "actions");
    const star = el("button", "iconbtn" + (stars.has(e.id) ? " starred" : ""), stars.has(e.id) ? "★" : "☆");
    star.title = stars.has(e.id) ? "In your trip — click to remove" : "Add to your trip itinerary"; star.addEventListener("click", () => { stars.has(e.id) ? stars.delete(e.id) : stars.add(e.id); LS.set("ev_stars", stars); render(); });
    const hide = el("button", "iconbtn", "✕");
    hide.title = "Hide"; hide.addEventListener("click", () => { hidden.has(e.id) ? hidden.delete(e.id) : hidden.add(e.id); LS.set("ev_hidden", hidden); render(); });
    actions.appendChild(star); actions.appendChild(hide); c.appendChild(actions);
    return c;
  }

  /* ---------- URL hash state (shareable filters) ---------- */
  function writeHash() {
    const p = new URLSearchParams();
    if (state.q) p.set("q", state.q);
    if (state.sort !== "soonest") p.set("sort", state.sort);
    if (state.date !== "upcoming") p.set("date", state.date);
    if (state.timeOfDay !== "any") p.set("tod", state.timeOfDay);
    if (state.from) p.set("from", state.from);
    if (state.to) p.set("to", state.to);
    if (state.cats.size) p.set("cat", [...state.cats].join(","));
    if (state.cities.size) p.set("city", [...state.cities].join(","));
    if (state.sources.size) p.set("src", [...state.sources].join(","));
    if (state.free) p.set("free", "1");
    if (state.curatedOnly) p.set("curated", "1");
    if (state.minScore) p.set("min", state.minScore);
    if (state.starred) p.set("starred", "1");
    const s = p.toString();
    history.replaceState(null, "", s ? "#" + s : location.pathname);
  }
  function parseHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const list = (k) => (p.get(k) ? p.get(k).split(",").filter(Boolean) : []);
    state.q = p.get("q") || "";
    state.sort = p.get("sort") || "soonest";
    state.date = p.get("date") || "30d";
    state.timeOfDay = p.get("tod") || "any";
    state.from = p.get("from") || ""; state.to = p.get("to") || "";
    list("cat").forEach((v) => state.cats.add(v));
    list("city").forEach((v) => state.cities.add(v));
    list("src").forEach((v) => state.sources.add(v));
    state.free = p.get("free") === "1";
    state.curatedOnly = p.get("curated") === "1";
    state.minScore = Number(p.get("min") || 0);
    state.starred = p.get("starred") === "1";
    // Shared itinerary link: ?pick=id1,id2… (optionally with from/to). Shown as a
    // separate "shared itinerary" view — does NOT touch the viewer's own stars.
    const pick = list("pick");
    if (pick.length) {
      state.pick = new Set(pick);
      if (p.get("from") && p.get("to")) { state.trip = { from: p.get("from"), to: p.get("to") }; state.date = "custom"; }
      else { state.date = "all"; }
    }
  }

  /* ---------- trip planner ---------- */
  function loadTrip() {
    if (state.trip) return; // already set from a shared ?pick link
    try {
      const t = JSON.parse(localStorage.getItem("ev_trip") || "null");
      if (t && t.from && t.to) { state.trip = t; state.date = "custom"; state.from = t.from; state.to = t.to; }
    } catch {}
  }
  function openTripPanel(force) {
    const panel = $("#trip-panel");
    if (state.trip) { $("#trip-from").value = state.trip.from; $("#trip-to").value = state.trip.to; }
    panel.hidden = force === true ? false : !panel.hidden;
  }
  function applyTrip() {
    let from = $("#trip-from").value, to = $("#trip-to").value;
    if (!from || !to) return;
    if (to < from) { const x = from; from = to; to = x; }
    state.trip = { from, to }; state.date = "custom"; state.from = from; state.to = to;
    localStorage.setItem("ev_trip", JSON.stringify(state.trip));
    $("#trip-panel").hidden = true;
    render();
  }
  function clearTrip() {
    state.trip = null; try { localStorage.removeItem("ev_trip"); } catch {}
    state.date = "30d"; state.from = ""; state.to = "";
    $("#trip-panel").hidden = true;
    render();
  }
  function renderTripBanner(count) {
    const box = $("#trip-banner");
    if (!state.trip) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false; box.innerHTML = "";
    const days = Math.max(1, Math.round((new Date(state.trip.to) - new Date(state.trip.from)) / 86400000) + 1);
    const fmtD = (s) => new Date(s + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const info = el("div", "trip-info");
    info.appendChild(el("span", "trip-emoji", "🧳"));
    const txt = el("div", "trip-text");
    txt.appendChild(el("strong", null, "Your Bay Area trip"));
    txt.appendChild(el("span", "trip-range", `${fmtD(state.trip.from)} → ${fmtD(state.trip.to)} · ${days} day${days === 1 ? "" : "s"} · ${count.toLocaleString()} events`));
    info.appendChild(txt);
    box.appendChild(info);
    const actions = el("div", "trip-banner-actions");
    const edit = el("button", "btn-ghost", "Edit dates"); edit.addEventListener("click", () => openTripPanel(true));
    const clr = el("button", "btn-ghost", "Clear"); clr.addEventListener("click", clearTrip);
    actions.appendChild(edit); actions.appendChild(clr);
    box.appendChild(actions);
  }

  /* ---------- itinerary · directions · calendar · share ---------- */
  const cityLabel = (id) => meta.city[id] || (id && id !== "unknown" ? id : "");
  const destOf = (e) => [e.venueName, e.address].filter(Boolean).join(", ");
  const gmapsUrl = (e) => { const d = destOf(e); return d ? "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(d) : null; };
  const foodUrl = (e) => { const near = destOf(e) || (e.city && e.city !== "unknown" ? cityLabel(e.city) : "San Francisco Bay Area"); return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent("restaurants near " + near); };
  function gcalUrl(e) {
    const f = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const start = f(e.startUtc);
    const end = e.endUtc ? f(e.endUtc) : f(new Date(new Date(e.startUtc).getTime() + 2 * 3600e3).toISOString());
    const loc = [e.venueName, e.address, cityLabel(e.city)].filter(Boolean).join(", ");
    return "https://calendar.google.com/calendar/render?" + new URLSearchParams({ action: "TEMPLATE", text: e.title, dates: start + "/" + end, location: loc, details: e.url }).toString();
  }
  const starredEvents = () => ALL.filter((e) => stars.has(e.id)).sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  const itineraryList = () => state.pick ? ALL.filter((e) => state.pick.has(e.id)).sort((a, b) => a.startUtc.localeCompare(b.startUtc)) : starredEvents();
  // ---- Travel/timing engine (free, no Maps API): approximate Bay-city coords ----
  const BAY_COORDS = {
    "san francisco": [37.7749, -122.4194], "daly city": [37.6879, -122.4702], "south san francisco": [37.6547, -122.4077],
    "san bruno": [37.6305, -122.4111], "millbrae": [37.5985, -122.3872], "burlingame": [37.5841, -122.3661],
    "san mateo": [37.5630, -122.3255], "belmont": [37.5202, -122.2758], "san carlos": [37.5072, -122.2605],
    "redwood city": [37.4852, -122.2364], "menlo park": [37.4530, -122.1817], "palo alto": [37.4419, -122.1430],
    "stanford": [37.4275, -122.1697], "mountain view": [37.3861, -122.0839], "los altos": [37.3852, -122.1141],
    "sunnyvale": [37.3688, -122.0363], "santa clara": [37.3541, -121.9552], "cupertino": [37.3230, -122.0322],
    "san jose": [37.3382, -121.8863], "milpitas": [37.4323, -121.8996], "fremont": [37.5485, -121.9886],
    "hayward": [37.6688, -122.0808], "union city": [37.5934, -122.0438], "oakland": [37.8044, -122.2712],
    "berkeley": [37.8715, -122.2730], "emeryville": [37.8313, -122.2852], "alameda": [37.7652, -122.2416],
    "san leandro": [37.7249, -122.1561], "richmond": [37.9358, -122.3477], "walnut creek": [37.9101, -122.0652],
  };
  const CITY_KEYS = Object.keys(BAY_COORDS).sort((a, b) => b.length - a.length);
  // Caltrain: approximate cumulative rail minutes from SF (from the published timetable).
  // Difference between two stations ≈ on-train time; we add a walk+wait buffer.
  const CALTRAIN_MIN = {
    "san francisco": 0, "south san francisco": 12, "san bruno": 16, "millbrae": 19, "burlingame": 24,
    "san mateo": 27, "belmont": 34, "san carlos": 37, "redwood city": 41, "menlo park": 45,
    "palo alto": 48, "mountain view": 57, "sunnyvale": 62, "santa clara": 70, "san jose": 74,
  };
  function eventCityName(e) {
    const hay = ((e.venueName || "") + " " + (e.address || "")).toLowerCase();
    for (const k of CITY_KEYS) if (hay.includes(k)) return k.replace(/\b\w/g, (c) => c.toUpperCase());
    if (/\bsf\b|\bs\.f\.|san fran/.test(hay)) return "San Francisco";
    return null;
  }
  function eventCoords(e) { const c = eventCityName(e); return c ? BAY_COORDS[c.toLowerCase()] : null; }
  function haversineKm(a, b) {
    const R = 6371, dLa = (b[0] - a[0]) * Math.PI / 180, dLo = (b[1] - a[1]) * Math.PI / 180;
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function travelMin(a, b) { const ca = eventCoords(a), cb = eventCoords(b); if (!ca || !cb) return null; const km = haversineKm(ca, cb); return km < 1.2 ? 10 : Math.round(10 + (km / 45) * 60); }
  function fmtDur(m) { m = Math.max(0, Math.round(m)); const h = Math.floor(m / 60), mm = m % 60; return (h ? h + "h " : "") + (mm || !h ? mm + "m" : "").trim(); }
  const isAllDay = (e) => timeLabel(e.startUtc, e.timezone) === "12:00 AM";
  function connectorRow(a, b) {
    const drive = travelMin(a, b), cityA = eventCityName(a), cityB = eventCityName(b);
    const railA = CALTRAIN_MIN[(cityA || "").toLowerCase()], railB = CALTRAIN_MIN[(cityB || "").toLowerCase()];
    const caltrain = railA != null && railB != null && cityA !== cityB ? Math.abs(railA - railB) + 20 : null;
    const routeStr = cityA && cityB && cityA !== cityB ? ` · ${cityA} → ${cityB}` : "";
    const parts = [];
    if (drive != null) parts.push("🚗 ~" + fmtDur(drive));
    if (caltrain != null) parts.push("🚆 Caltrain ~" + fmtDur(caltrain));
    const travelStr = parts.length ? parts.join(" · ") + routeStr : routeStr ? routeStr.replace(/^ · /, "") : null;
    const best = [drive, caltrain].filter((x) => x != null);
    const bestTravel = best.length ? Math.min(...best) : null;
    let cls = "ok", txt, bigGap = false;
    if (!isAllDay(a) && !isAllDay(b)) {
      const aEnd = a.endUtc ? new Date(a.endUtc).getTime() : new Date(a.startUtc).getTime() + 2 * 3600e3;
      const gapMin = Math.round((new Date(b.startUtc).getTime() - aEnd) / 60000);
      if (gapMin < 0) { cls = "bad"; txt = "⚠ Overlaps by " + fmtDur(-gapMin); }
      else if (bestTravel != null && bestTravel > gapMin + 5) { cls = "warn"; txt = "⚠ Tight — " + fmtDur(gapMin) + " gap · " + travelStr; }
      else { txt = fmtDur(gapMin) + " free" + (travelStr ? " · " + travelStr : ""); bigGap = gapMin >= 75; }
    } else { if (!travelStr) return null; txt = travelStr; }
    const conn = el("div", "connector " + cls);
    conn.appendChild(el("span", "conn-dot")); conn.appendChild(el("span", "conn-txt", txt));
    if (bigGap) { const f = el("a", "conn-food", "🍽 grab food"); f.href = foodUrl(b); f.target = "_blank"; f.rel = "noopener"; conn.appendChild(f); }
    return conn;
  }

  // OCD planner: flag itinerary events whose times overlap (can't be two places at once).
  let CONFLICTS = {};
  function computeConflicts() {
    const list = itineraryList(); const map = {};
    const iv = (e) => { const s = new Date(e.startUtc).getTime(); return [s, e.endUtc ? new Date(e.endUtc).getTime() : s + 2 * 3600e3]; };
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = iv(list[i]), b = iv(list[j]);
      if (a[0] < b[1] && b[0] < a[1]) { (map[list[i].id] ||= []).push(list[j].title); (map[list[j].id] ||= []).push(list[i].title); }
    }
    return map;
  }
  function routeUrl(list) {
    const stops = list.map(destOf).filter(Boolean);
    if (!stops.length) return null;
    const dest = encodeURIComponent(stops[stops.length - 1]);
    const wp = stops.slice(0, -1).slice(0, 9).map(encodeURIComponent).join("|");
    return "https://www.google.com/maps/dir/?api=1&destination=" + dest + (wp ? "&waypoints=" + wp : "");
  }
  const icsEsc = (s) => String(s).replace(/([,;\\])/g, "\\$1").replace(/\r?\n/g, " ");
  function exportIcs(list) {
    const pad = (n) => String(n).padStart(2, "0");
    const dt = (iso) => { const d = new Date(iso); return "" + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + "T" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + "00Z"; };
    let ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//The Bay//Trip//EN\r\nCALSCALE:GREGORIAN\r\n";
    for (const e of list) {
      ics += "BEGIN:VEVENT\r\nUID:" + e.id + "@thebay.events\r\nDTSTART:" + dt(e.startUtc) + "\r\n";
      if (e.endUtc) ics += "DTEND:" + dt(e.endUtc) + "\r\n";
      ics += "SUMMARY:" + icsEsc(e.title) + "\r\n";
      const loc = [e.venueName, e.address].filter(Boolean).join(", "); if (loc) ics += "LOCATION:" + icsEsc(loc) + "\r\n";
      ics += "URL:" + e.url + "\r\nDESCRIPTION:" + icsEsc(e.url) + "\r\nEND:VEVENT\r\n";
    }
    ics += "END:VCALENDAR\r\n";
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" })); a.download = "my-bay-trip.ics"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function tripLabel() {
    if (!state.trip) return "";
    const f = (s) => new Date(s + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return f(state.trip.from) + " – " + f(state.trip.to);
  }
  function shareLink(list) {
    const p = new URLSearchParams();
    if (state.trip) { p.set("from", state.trip.from); p.set("to", state.trip.to); }
    p.set("pick", list.map((e) => e.id).join(","));
    return location.origin + location.pathname + "#" + p.toString();
  }
  function qrMatrix(url) {
    if (typeof qrcode === "undefined") return null;
    try {
      const q = qrcode(0, "M"); q.addData(url); q.make();
      const n = q.getModuleCount(); const m = [];
      for (let r = 0; r < n; r++) { const row = []; for (let c = 0; c < n; c++) row.push(q.isDark(r, c)); m.push(row); }
      return m;
    } catch { return null; }
  }
  function qrSvg(url, size) {
    const m = qrMatrix(url); if (!m) return null;
    const n = m.length, pad = 2, total = n + pad * 2; let rects = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) rects += `<rect x="${c + pad}" y="${r + pad}" width="1.02" height="1.02"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#fff"/><g fill="#0d1218">${rects}</g></svg>`;
  }
  function renderItinerary() {
    const bar = $("#itinerary-bar"); const list = itineraryList();
    bar.innerHTML = "";
    // Empty state — always shown so the plan/itinerary/share flow is discoverable.
    if (!list.length) {
      bar.hidden = false; bar.classList.add("empty");
      const info = el("div", "itin-info"); info.appendChild(el("span", "itin-emoji", "🗓️"));
      const t = el("div");
      t.appendChild(el("strong", null, "Plan your trip itinerary"));
      t.appendChild(el("span", "itin-sub", "Tap the ☆ star on any event to add it — then get a Google Maps route, add to your calendar, and share or print a card."));
      info.appendChild(t); bar.appendChild(info);
      return;
    }
    bar.classList.remove("empty");
    bar.hidden = false;
    const nConf = Object.keys(CONFLICTS).length;
    const info = el("div", "itin-info"); info.appendChild(el("span", "itin-emoji", "🗓️"));
    const t = el("div");
    t.appendChild(el("strong", null, state.pick ? "Shared itinerary" : "My itinerary"));
    const subEl = el("span", "itin-sub", list.length + (state.pick ? " events" : " starred") + (state.trip ? " · " + tripLabel() : ""));
    if (nConf) subEl.appendChild(el("span", "itin-conflict", "  ⚠ " + nConf + " time conflict" + (nConf > 1 ? "s" : "")));
    t.appendChild(subEl); info.appendChild(t); bar.appendChild(info);
    const acts = el("div", "itin-actions");
    if (!state.pick) {
      const view = el("button", "btn-ghost" + (state.starred ? " active" : ""), state.starred ? "← All events" : "📋 View my schedule");
      view.addEventListener("click", () => { state.starred = !state.starred; if (state.starred) state.sort = "soonest"; render(); });
      acts.appendChild(view);
    }
    const r = routeUrl(list);
    if (r) { const route = el("a", "btn-ghost", "🗺️ Route"); route.href = r; route.target = "_blank"; route.rel = "noopener"; acts.appendChild(route); }
    const cal = el("button", "btn-ghost", "📅 Calendar"); cal.addEventListener("click", () => exportIcs(list)); acts.appendChild(cal);
    const share = el("button", "btn-primary", "↗ Share / Print"); share.addEventListener("click", () => openShare(list)); acts.appendChild(share);
    bar.appendChild(acts);
  }
  function openShare(list) {
    const card = $("#share-card"); card.innerHTML = "";
    const head = el("div", "sc-head");
    const left = el("div", "sc-head-left"); left.appendChild(el("span", "sc-logo", "📡"));
    const h = el("div"); h.appendChild(el("div", "sc-title", "My SF Bay Startup Trip"));
    h.appendChild(el("div", "sc-sub", (state.trip ? tripLabel() + " · " : "") + list.length + " events"));
    left.appendChild(h); head.appendChild(left);
    const svg = qrSvg(shareLink(list), 88);
    if (svg) { const qd = el("div", "sc-qr"); qd.innerHTML = svg + '<div class="sc-qr-lbl">Scan for this trip</div>'; head.appendChild(qd); }
    card.appendChild(head);
    let key = null, grp = null;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const k = dayKey(e.startUtc, e.timezone);
      if (k !== key) { key = k; grp = el("div", "sc-day"); grp.appendChild(el("div", "sc-dayhdr", dayLabel(e.startUtc, e.timezone))); card.appendChild(grp); }
      const ts = timeLabel(e.startUtc, e.timezone);
      const row = el("div", "sc-ev"); row.appendChild(el("span", "sc-time", ts === "12:00 AM" ? "All day" : ts));
      const m = el("div", "sc-evbody"); const nameEl = el("div", "sc-evname", e.title);
      if (CONFLICTS[e.id]) { row.classList.add("sc-conflict"); nameEl.appendChild(el("span", "sc-warn", " ⚠ overlap")); }
      m.appendChild(nameEl);
      const v = [e.venueName, cityLabel(e.city)].filter(Boolean).join(" · "); if (v) m.appendChild(el("div", "sc-evloc", v));
      row.appendChild(m); grp.appendChild(row);
      // travel/gap line between consecutive same-day events
      if (i + 1 < list.length) {
        const next = list[i + 1];
        if (dayKey(next.startUtc, next.timezone) === k) {
          const conn = connectorRow(e, next);
          if (conn) { const sc = el("div", "sc-conn" + (conn.classList.contains("bad") ? " bad" : conn.classList.contains("warn") ? " warn" : ""), "↳ " + conn.querySelector(".conn-txt").textContent); grp.appendChild(sc); }
        }
      }
    }
    card.appendChild(el("div", "sc-foot", "📡 thebay.events"));
    const text = `My SF Bay startup trip — ${list.length} events${state.trip ? " (" + tripLabel() + ")" : ""} 📡`;
    $("#sc-x").href = "https://twitter.com/intent/tweet?text=" + encodeURIComponent(text) + "&url=" + encodeURIComponent(shareLink(list));
    $("#share-modal").hidden = false;
  }
  function trunc(ctx, s, maxW) { if (ctx.measureText(s).width <= maxW) return s; let t = s; while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1); return t + "…"; }
  function downloadCard(list) {
    const W = 1080, PAD = 60;
    const days = []; let key = null;
    for (const e of list) { const k = dayKey(e.startUtc, e.timezone); if (k !== key) { key = k; days.push({ label: dayLabel(e.startUtc, e.timezone), evs: [] }); } days[days.length - 1].evs.push(e); }
    const qm = qrMatrix(shareLink(list));
    const headerH = qm ? 214 : 150;
    let H = PAD + headerH; for (const d of days) H += 50 + d.evs.length * 74 + 14; H += 90;
    const c = document.createElement("canvas"); c.width = W; c.height = H; const ctx = c.getContext("2d");
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#0b0f16"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#4f9dff"; ctx.fillRect(0, 0, W, 8);
    ctx.font = "44px system-ui"; ctx.fillText("📡", PAD, PAD + 54);
    ctx.fillStyle = "#eef1f6"; ctx.font = "700 46px system-ui"; ctx.fillText("My SF Bay Startup Trip", PAD + 66, PAD + 50);
    ctx.fillStyle = "#8b95a3"; ctx.font = "500 26px system-ui"; ctx.fillText((state.trip ? tripLabel() + "  ·  " : "") + list.length + " events", PAD + 66, PAD + 92);
    if (qm) {
      const n = qm.length, qs = 170, cell = qs / (n + 4), ox = W - PAD - qs, oy = PAD - 8;
      ctx.fillStyle = "#fff"; ctx.fillRect(ox, oy, qs, qs);
      ctx.fillStyle = "#0d1218";
      for (let r = 0; r < n; r++) for (let cc = 0; cc < n; cc++) if (qm[r][cc]) ctx.fillRect(ox + (cc + 2) * cell, oy + (r + 2) * cell, cell + 0.6, cell + 0.6);
      ctx.fillStyle = "#8b95a3"; ctx.font = "500 18px system-ui"; ctx.textAlign = "center"; ctx.fillText("Scan for this trip", ox + qs / 2, oy + qs + 26); ctx.textAlign = "left";
    }
    let y = PAD + headerH;
    for (const d of days) {
      ctx.fillStyle = "#c2cad6"; ctx.font = "700 24px system-ui"; ctx.fillText(d.label.toUpperCase(), PAD, y);
      ctx.strokeStyle = "#212b39"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(PAD, y + 14); ctx.lineTo(W - PAD, y + 14); ctx.stroke();
      y += 50;
      for (const e of d.evs) {
        ctx.fillStyle = "#4f9dff"; ctx.font = "700 26px system-ui";
        const ts = timeLabel(e.startUtc, e.timezone); ctx.fillText(ts === "12:00 AM" ? "All day" : ts, PAD, y + 22);
        ctx.fillStyle = "#eef1f6"; ctx.font = "600 28px system-ui"; ctx.fillText(trunc(ctx, e.title, W - PAD - 250), PAD + 200, y + 18);
        const v = [e.venueName, cityLabel(e.city)].filter(Boolean).join(" · ");
        if (v) { ctx.fillStyle = "#8b95a3"; ctx.font = "400 22px system-ui"; ctx.fillText(trunc(ctx, v, W - PAD - 250), PAD + 200, y + 48); }
        y += 74;
      }
      y += 14;
    }
    ctx.fillStyle = "#4f9dff"; ctx.font = "700 26px system-ui"; ctx.fillText("📡 thebay.events", PAD, H - 44);
    c.toBlob((b) => { const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "my-bay-trip.png"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); });
  }

  /* ---------- wiring ---------- */
  function bindUI() {
    initTheme();
    const syncTopbar = () => { const tb = $(".topbar"); if (tb) document.documentElement.style.setProperty("--topbar-h", tb.offsetHeight + "px"); };
    syncTopbar();
    window.addEventListener("resize", syncTopbar);
    $("#trip-btn").addEventListener("click", () => openTripPanel());
    $("#sc-download").addEventListener("click", () => downloadCard(starredEvents()));
    $("#sc-copy").addEventListener("click", async (ev) => { try { await navigator.clipboard.writeText(shareLink(starredEvents())); ev.target.textContent = "✓ Copied"; setTimeout(() => (ev.target.textContent = "🔗 Copy link"), 1500); } catch {} });
    $("#sc-print").addEventListener("click", () => window.print());
    $("#sc-close").addEventListener("click", () => ($("#share-modal").hidden = true));
    $("#share-modal").addEventListener("click", (ev) => { if (ev.target.id === "share-modal") $("#share-modal").hidden = true; });
    $("#trip-apply").addEventListener("click", applyTrip);
    $("#trip-clear").addEventListener("click", clearTrip);
    const search = $("#search"); search.value = state.q;
    search.addEventListener("input", (e) => { state.q = e.target.value.trim().toLowerCase(); render(); });
    $("#sort").addEventListener("click", (e) => { const b = e.target.closest("[data-sort]"); if (b) { state.sort = b.dataset.sort; render(); } });
    $("#date-chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-date]"); if (!b) return;
      if (b.dataset.date !== "custom" && state.trip) { state.trip = null; try { localStorage.removeItem("ev_trip"); } catch {} }
      state.date = b.dataset.date;
      if (b.dataset.date !== "custom") { state.from = ""; state.to = ""; }
      $("#custom-dates").hidden = state.date !== "custom";
      render();
    });
    $("#from").addEventListener("change", (e) => { state.from = e.target.value; state.date = "custom"; render(); });
    $("#to").addEventListener("change", (e) => { state.to = e.target.value; state.date = "custom"; render(); });
    $("#time-chips").addEventListener("click", (e) => { const b = e.target.closest("[data-time]"); if (b) { state.timeOfDay = b.dataset.time; render(); } });
    const ms = $("#minScore"); ms.value = state.minScore; $("#minScoreOut").textContent = state.minScore;
    ms.addEventListener("input", (e) => { state.minScore = Number(e.target.value); $("#minScoreOut").textContent = state.minScore; render(); });
    for (const [id, key] of TOGGLES) {
      const box = $("#" + id); box.checked = state[key];
      box.addEventListener("change", (e) => { state[key] = e.target.checked; render(); });
    }
    document.querySelectorAll(".clearbtn").forEach((b) => b.addEventListener("click", () => { state[b.dataset.clear].clear(); render(); }));
    const rs = $("#rescrape");
    if (rs) rs.addEventListener("click", async () => {
      rs.disabled = true; rs.textContent = "↻ Scraping…";
      try { await fetch("/api/scrape", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); } catch {}
      setTimeout(() => { rs.disabled = false; rs.textContent = "↻ Scrape"; location.reload(); }, 8000);
    });
  }

  boot().catch((err) => { $("#events").innerHTML = `<div class="empty"><p>Failed to load.</p><p class="muted">${err.message}</p></div>`; });
})();
