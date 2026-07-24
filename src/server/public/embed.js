"use strict";
(function () {
  const boot = window.__EVENTERS__ || null;
  const $ = (s) => document.querySelector(s);
  const el = (t, c, txt) => {
    const n = document.createElement(t);
    if (c) n.className = c;
    if (txt != null) n.textContent = txt;
    return n;
  };

  const state = { q: "", cats: new Set(), day: "all", tod: "any" };
  let events = [];
  let catMeta = {}; // id -> {label, color}

  function fmt(iso, tz, opts) {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }).format(new Date(iso));
    } catch {
      return new Intl.DateTimeFormat("en-US", opts).format(new Date(iso));
    }
  }
  const dayKey = (iso, tz) => fmt(iso, tz, { year: "numeric", month: "2-digit", day: "2-digit" });
  const dayLabel = (iso, tz) => fmt(iso, tz, { weekday: "short", month: "short", day: "numeric" });
  const timeLabel = (iso, tz) => fmt(iso, tz, { hour: "numeric", minute: "2-digit" });
  const eventHour = (iso, tz) => { try { return parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date(iso)), 10) % 24; } catch { return new Date(iso).getHours(); } };
  function dayWindow() {
    const now = new Date(); const s = new Date(now); s.setHours(0, 0, 0, 0);
    const d = (n) => { const x = new Date(s); x.setDate(x.getDate() + n); return x; };
    switch (state.day) {
      case "today": return [s, d(1)];
      case "weekend": { const dow = now.getDay(); const sat = d((6 - dow + 7) % 7); const mon = new Date(sat); mon.setDate(mon.getDate() + 2); return [sat, mon]; }
      case "7d": return [new Date(now.getTime() - 6 * 3600e3), d(7)];
      case "30d": return [new Date(now.getTime() - 6 * 3600e3), d(30)];
      default: return [null, null];
    }
  }

  function ingest(d) {
    events = (d.events || []).filter((e) => new Date(e.startUtc).getTime() > Date.now() - 6 * 3600e3);
    (d.categories || []).forEach((c) => (catMeta[c.id] = c));
    if (d.updatedAt || d.generatedAt) $("#ev-updated").textContent = "updated " + relTime(d.updatedAt || d.generatedAt);
    if (d.siteUrl) $("#ev-more").href = d.siteUrl;
  }
  async function load() {
    // 1) inlined bundle  2) sibling events.json (static site)  3) live API
    if (boot && Array.isArray(boot.events)) return ingest(boot);
    try {
      const r = await fetch("./events.json", { cache: "no-store" });
      if (r.ok) return ingest(await r.json());
    } catch {}
    const [ev, cats] = await Promise.all([
      fetch("/api/events?limit=800").then((r) => r.json()),
      fetch("/api/categories").then((r) => r.json()),
    ]);
    events = ev.events || [];
    (cats || []).forEach((c) => (catMeta[c.id] = c));
  }

  function relTime(iso) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }

  function renderChips() {
    const box = $("#ev-cats");
    box.innerHTML = "";
    const present = new Set();
    events.forEach((e) => (e.categories || []).forEach((c) => present.add(c)));
    const order = Object.keys(catMeta).filter((c) => present.has(c));
    for (const id of order) {
      const chip = el("button", "ev-chip");
      chip.setAttribute("aria-pressed", state.cats.has(id) ? "true" : "false");
      chip.style.color = state.cats.has(id) ? catMeta[id].color : "";
      const dot = el("span", "cdot");
      dot.style.background = catMeta[id].color || "#8d99ae";
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(catMeta[id].label || id));
      chip.addEventListener("click", () => {
        state.cats.has(id) ? state.cats.delete(id) : state.cats.add(id);
        renderChips();
        renderList();
      });
      box.appendChild(chip);
    }
  }

  function match(e) {
    if (state.cats.size && !(e.categories || []).some((c) => state.cats.has(c))) return false;
    const [from, to] = dayWindow();
    const t = new Date(e.startUtc).getTime();
    if (from && t < from.getTime()) return false;
    if (to && t >= to.getTime()) return false;
    if (state.tod !== "any" && timeLabel(e.startUtc, e.timezone) !== "12:00 AM") {
      const h = eventHour(e.startUtc, e.timezone);
      if (state.tod === "morning" && !(h < 12)) return false;
      if (state.tod === "afternoon" && !(h >= 12 && h < 17)) return false;
      if (state.tod === "evening" && h < 17) return false;
    }
    if (state.q) {
      const hay = (e.title + " " + (e.organizer || "") + " " + (e.venueName || "")).toLowerCase();
      if (!state.q.split(/\s+/).every((tok) => hay.includes(tok))) return false;
    }
    return true;
  }

  function renderList() {
    const list = $("#ev-list");
    list.innerHTML = "";
    const shown = events.filter(match);
    $("#ev-count").textContent = shown.length + " event" + (shown.length === 1 ? "" : "s");
    $("#ev-empty").hidden = shown.length > 0;

    let curKey = null;
    let group = null;
    for (const e of shown) {
      const k = dayKey(e.startUtc, e.timezone);
      if (k !== curKey) {
        curKey = k;
        const h = el("div", "ev-day");
        h.appendChild(document.createTextNode(dayLabel(e.startUtc, e.timezone)));
        list.appendChild(h);
        group = list;
      }
      const item = el("div", "ev-item");
      const ts = timeLabel(e.startUtc, e.timezone);
      const time = el("div", "ev-time", ts === "12:00 AM" ? "All day" : ts);
      item.appendChild(time);
      const main = el("div", "ev-main");
      const name = el("div", "ev-name");
      const a = el("a", null, e.title);
      a.href = e.url;
      a.target = "_blank";
      a.rel = "noopener";
      name.appendChild(a);
      main.appendChild(name);
      const row2 = el("div", "ev-row2");
      // The whole widget is region-scoped, so show the venue, not the city id.
      if (e.venueName) row2.appendChild(el("span", null, "📍 " + e.venueName));
      else if (e.organizer) row2.appendChild(el("span", null, e.organizer));
      const badges = el("span", "ev-badges");
      for (const c of e.categories || []) {
        const b = el("span", "ev-badge", (catMeta[c] && catMeta[c].label) || c);
        b.style.background = (catMeta[c] && catMeta[c].color) || "#8d99ae";
        badges.appendChild(b);
      }
      if (e.isFree === true) badges.appendChild(el("span", "ev-free", "Free"));
      row2.appendChild(badges);
      main.appendChild(row2);
      item.appendChild(main);
      group.appendChild(item);
    }
  }

  $("#ev-search").addEventListener("input", (e) => {
    state.q = e.target.value.trim().toLowerCase();
    renderList();
  });
  $("#ev-days").addEventListener("click", (e) => {
    const b = e.target.closest("[data-day]"); if (!b) return;
    state.day = b.dataset.day;
    for (const x of $("#ev-days").children) x.classList.toggle("on", x === b);
    renderList();
  });
  $("#ev-times").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tod]"); if (!b) return;
    state.tod = b.dataset.tod;
    for (const x of $("#ev-times").children) x.classList.toggle("on", x === b);
    renderList();
  });

  load()
    .then(() => {
      renderChips();
      renderList();
    })
    .catch((err) => {
      $("#ev-list").innerHTML = "";
      const d = el("div", "ev-empty", "Couldn't load events. " + err.message);
      $("#ev-list").appendChild(d);
    });
})();
