// Client-side web-push opt-in. Fetches the server VAPID key, asks the browser to
// subscribe via the service worker, and registers the subscription. No-ops
// gracefully where push isn't supported or configured.

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export async function pushEnabled(): Promise<boolean> {
  const r = await fetch("/api/push/key").then((x) => x.json()).catch(() => ({ enabled: false }));
  return !!r.enabled;
}

/** Returns "subscribed" | "denied" | "unsupported" | "unconfigured" | "error". */
export async function subscribeToPush(): Promise<string> {
  if (!pushSupported()) return "unsupported";
  const { key, enabled } = await fetch("/api/push/key").then((r) => r.json()).catch(() => ({ key: null, enabled: false }));
  if (!enabled || !key) return "unconfigured";

  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "denied";

  try {
    const reg = await navigator.serviceWorker.ready;
    const sub =
      (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) as BufferSource }));
    await fetch("/api/me/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(sub.toJSON()),
    });
    return "subscribed";
  } catch {
    return "error";
  }
}
