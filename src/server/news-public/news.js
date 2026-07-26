/*
 * thebay.news — progressive enhancement only.
 *
 * Every feature here has a working no-JS fallback: filter chips are real links,
 * the comment box is a real form, voting falls back to a POST. This file makes
 * those instant; it never makes them possible. If it fails to load, the site
 * still works.
 *
 * No framework, no build step, ~3KB.
 */
(function () {
  "use strict";

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  // ── theme ──────────────────────────────────────────────────────────────────
  // Three states, cycled: auto → light → dark. "auto" removes data-theme so the
  // CSS prefers-color-scheme rules apply and KEEP applying — if the OS switches
  // to dark at sunset, so does the page. A two-state toggle can't express that:
  // once you tap it you're pinned forever with no way back.
  var THEMES = ["auto", "light", "dark"];
  var ICON = { auto: "◐", light: "☀", dark: "☾" };

  function storedTheme() {
    try { var t = localStorage.getItem("bay-theme"); return THEMES.indexOf(t) >= 0 ? t : "auto"; }
    catch (_) { return "auto"; }
  }
  function applyTheme(t) {
    if (t === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("bay-theme", t); } catch (_) {}
    paintTheme();
  }
  /** What's actually on screen right now, whichever way we got there. */
  function effectiveTheme() {
    return document.documentElement.getAttribute("data-theme") ||
      (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  }
  function paintTheme() {
    var t = storedTheme();
    var icon = $("[data-theme-icon]"), name = $("[data-theme-name]"), btn = $("[data-theme-toggle]");
    if (icon) icon.textContent = ICON[t];
    if (name) name.textContent = " " + t;
    if (btn) {
      btn.setAttribute(
        "aria-label",
        t === "auto" ? "Theme: follow system. Click for light." :
        t === "light" ? "Theme: light. Click for dark." : "Theme: dark. Click to follow system.",
      );
    }
  }
  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-theme-toggle]");
    if (!btn) return;
    applyTheme(THEMES[(THEMES.indexOf(storedTheme()) + 1) % THEMES.length]);
  });
  paintTheme();

  // Carry the theme across to thebay.events — localStorage can't span domains.
  $$("a.switch").forEach(function (a) {
    try {
      var u = new URL(a.href);
      u.searchParams.set("theme", effectiveTheme());
      a.href = u.toString();
    } catch (_) {}
  });

  // ── voting ─────────────────────────────────────────────────────────────────
  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-vote]");
    if (!btn) return;
    e.preventDefault();
    if (btn.getAttribute("data-needs-auth")) { location.href = "/login"; return; }

    var id = btn.getAttribute("data-vote");
    var on = btn.getAttribute("aria-pressed") === "true";
    var counter = $('[data-votes="' + id + '"]');

    // A zero counter is rendered hidden (see story.ts) — reveal it and its
    // separator once the story actually has support.
    function paint(n) {
      if (!counter) return;
      counter.textContent = String(n);
      counter.hidden = n <= 0;
      var sep = counter.previousElementSibling;
      if (sep && sep.classList.contains("dot")) sep.hidden = n <= 0;
    }

    // Optimistic: the vote is idempotent server-side, so a failed request just
    // reverts rather than corrupting anything.
    btn.setAttribute("aria-pressed", on ? "false" : "true");
    if (counter) paint(Math.max(0, (parseInt(counter.textContent, 10) || 0) + (on ? -1 : 1)));

    fetch("/api/news/vote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ storyId: id, on: !on }),
    })
      .then(function (r) {
        if (r.status === 401) { location.href = "/login"; return null; }
        if (r.status === 403) return r.json().then(function (b) { throw b; });
        if (!r.ok) throw new Error("vote failed");
        return r.json();
      })
      .then(function (body) {
        if (body && typeof body.votes === "number") paint(body.votes);
      })
      .catch(function (err) {
        btn.setAttribute("aria-pressed", on ? "true" : "false");
        if (counter) paint(Math.max(0, (parseInt(counter.textContent, 10) || 0) + (on ? 1 : -1)));
        if (err && err.error === "not_in_bay") askForLocation();
      });
  });

  // ── Bay attestation ────────────────────────────────────────────────────────
  function askForLocation() {
    if (!navigator.geolocation) { alert("Your browser can't share a location, so posting isn't available here."); return; }
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        fetch("/api/news/attest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        })
          .then(function (r) { return r.json(); })
          .then(function (b) {
            if (b && b.ok) location.reload();
            else alert("You need to be in the Bay Area to post here. Reading is open to everyone.");
          })
          .catch(function () {});
      },
      function () { alert("Location permission is needed to post — reading stays open to everyone."); },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 }
    );
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-attest]");
    if (b) { e.preventDefault(); askForLocation(); }
  });

  // ── flagging ───────────────────────────────────────────────────────────────
  // Reports to a human. It never hides anything, so the UI says exactly that —
  // an affordance that implied removal would invite pile-ons.
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-flag]");
    if (!b) return;
    e.preventDefault();
    var parts = (b.getAttribute("data-flag") || "").split(":");
    var reason = window.prompt("Report this to a moderator?\n\nReason: spam, off_topic, abuse, duplicate, broken, other", "spam");
    if (!reason) return;

    fetch("/api/news/flag", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ targetType: parts[0], targetId: parts[1], reason: reason.trim().toLowerCase() }),
    })
      .then(function (r) {
        if (r.status === 401) { location.href = "/login"; return null; }
        return r.json();
      })
      .then(function (body) {
        if (!body) return;
        if (body.ok) { b.textContent = "flagged"; b.disabled = true; b.style.color = "var(--muted)"; }
        else if (body.message) alert(body.message);
      })
      .catch(function () {});
  });

  // ── comment collapse ───────────────────────────────────────────────────────
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-collapse]");
    if (!b) return;
    e.preventDefault();
    var c = b.closest(".comment");
    var collapsed = c.getAttribute("data-collapsed") === "true";
    c.setAttribute("data-collapsed", collapsed ? "false" : "true");
    b.textContent = collapsed ? "[−]" : "[+]";
    b.setAttribute("aria-label", collapsed ? "Collapse thread" : "Expand thread");
  });

  // ── inline reply ───────────────────────────────────────────────────────────
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-reply]");
    if (!b) return;
    e.preventDefault();
    var form = $("[data-comment-form]");
    if (!form) return;
    var existing = form.querySelector('input[name="parentId"]');
    if (existing) existing.remove();
    var hidden = document.createElement("input");
    hidden.type = "hidden";
    hidden.name = "parentId";
    hidden.value = b.getAttribute("data-reply");
    form.appendChild(hidden);
    var c = b.closest(".comment");
    c.parentNode.insertBefore(form, c.nextSibling);
    var ta = form.querySelector("textarea");
    if (ta) ta.focus();
  });

  // ── live thread (presence + new comments) ──────────────────────────────────
  // Pure enhancement: the thread is fully server-rendered before this runs, and
  // stays correct if the socket never opens.
  (function live() {
    var head = $(".comments-head");
    if (!head) return;
    var m = /^\/item\/([^/]+)/.exec(location.pathname);
    if (!m || !("WebSocket" in window)) return;
    var storyId = m[1];

    var badge = document.createElement("span");
    badge.className = "mono";
    badge.style.cssText = "float:right;color:var(--accent);font-weight:400;text-transform:none;letter-spacing:0";
    head.appendChild(badge);

    var ws, retries = 0, ping;
    function connect() {
      try {
        ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/item/" + storyId);
      } catch (_) { return; }

      ws.onopen = function () { retries = 0; ping = setInterval(function () { try { ws.send("ping"); } catch (_) {} }, 45000); };

      ws.onmessage = function (ev) {
        var msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (msg.type === "presence" || msg.type === "pong") {
          var n = msg.readers || 0;
          badge.textContent = n > 1 ? "◉ " + n + " reading" : "";
        } else if (msg.type === "comment") {
          // Don't try to splice someone else's comment into the tree from the
          // client — the server owns thread structure. Offer a refresh instead,
          // which is honest and can't render a malformed thread.
          if (!$("[data-new-comments]")) {
            var n = document.createElement("div");
            n.className = "notice";
            n.setAttribute("data-new-comments", "1");
            n.innerHTML = '<strong>New comment.</strong> <a href="">Refresh to see it →</a>';
            head.parentNode.insertBefore(n, head.nextSibling);
          }
        }
      };

      ws.onclose = function () {
        clearInterval(ping);
        badge.textContent = "";
        // Back off, and give up rather than hammering a Worker that's unhappy.
        if (retries < 5) setTimeout(connect, Math.min(30000, 1000 * Math.pow(2, retries++)));
      };
      ws.onerror = function () { try { ws.close(); } catch (_) {} };
    }
    connect();
    window.addEventListener("pagehide", function () { try { ws && ws.close(); } catch (_) {} });
  })();

  // ── keyboard navigation ────────────────────────────────────────────────────
  var cursor = -1;
  function rows() { return $$(".story"); }
  function focusRow(i) {
    var list = rows();
    if (!list.length) return;
    cursor = Math.max(0, Math.min(i, list.length - 1));
    var el = list[cursor];
    $$(".story").forEach(function (r) { r.style.outline = ""; });
    el.style.outline = "1px solid var(--accent-soft)";
    el.style.outlineOffset = "4px";
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  document.addEventListener("keydown", function (e) {
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === "j") { e.preventDefault(); focusRow(cursor + 1); }
    else if (e.key === "k") { e.preventDefault(); focusRow(cursor - 1); }
    else if (e.key === "o" || e.key === "Enter") {
      var el = rows()[cursor]; if (!el) return;
      var a = $(".story-title a", el); if (a) { e.preventDefault(); a.click(); }
    } else if (e.key === "c") {
      var el2 = rows()[cursor]; if (!el2) return;
      var links = $$(".story-meta a", el2).filter(function (x) { return /comment/.test(x.textContent); });
      if (links[0]) { e.preventDefault(); links[0].click(); }
    } else if (e.key === "v") {
      var el3 = rows()[cursor]; if (!el3) return;
      var vb = $("[data-vote]", el3); if (vb) { e.preventDefault(); vb.click(); }
    }
  });
})();
