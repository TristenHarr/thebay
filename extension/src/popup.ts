/**
 * The popup: a switch, two fields, and an honest status line.
 *
 * Everything real happens in the service worker; this only reads and writes settings. The
 * token is stored in `chrome.storage.local` and never re-displayed once saved — it is a
 * bearer credential, and a password field that helpfully shows you the secret is not.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const chrome: any;

const $ = (id: string) => document.getElementById(id) as HTMLInputElement & HTMLElement;

async function render(state: any) {
  $("jobs").textContent = String(state.stats?.jobs ?? 0);
  $("found").textContent = String(state.stats?.found ?? 0);
  $("tier").textContent = state.stats?.tier ?? "—";
  $("status").textContent = state.stats?.status ?? "Idle.";
  const toggle = $("toggle");
  toggle.textContent = state.enabled ? "Stop working" : "Start working";
  toggle.className = state.enabled ? "off" : "";
}

async function load() {
  const d = await chrome.storage.local.get(["baseUrl", "token", "enabled", "stats"]);
  $("url").value = d.baseUrl || "https://thebay.events";
  // Present but never revealed: a placeholder says it's set, the value stays in storage.
  if (d.token) $("token").placeholder = "•••••••• (saved)";
  await render(d);
}

$("toggle").addEventListener("click", async () => {
  const d = await chrome.storage.local.get(["token", "enabled"]);
  const typed = $("token").value.trim();
  const token = typed || d.token || "";
  if (!token) {
    $("status").textContent = "Paste the worker token you got from Register this browser.";
    return;
  }
  await chrome.storage.local.set({ baseUrl: $("url").value.trim() || "https://thebay.events", token });
  $("token").value = "";
  $("token").placeholder = "•••••••• (saved)";
  const state = await chrome.runtime.sendMessage({ type: "setEnabled", enabled: !d.enabled });
  await render(state);
});

// Live status while the popup is open — the service worker writes progress into storage.
chrome.storage.onChanged.addListener(async (changes: any) => {
  if (changes.stats || changes.enabled) await load();
});

load();
