import type { Env } from "../worker/env";

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const token = () => (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");

/** Create a single-use magic link, email it, and (in dev, when no email provider
 *  is configured) return the link so the flow is testable end-to-end. */
export async function requestMagicLink(env: Env, email: string, origin: string): Promise<{ devLink?: string }> {
  const t = token();
  const hash = await sha256hex(t);
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  await env.DB
    .prepare("INSERT INTO magic_links (token_hash, email, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)")
    .bind(hash, email.toLowerCase(), expires, new Date().toISOString())
    .run();
  const link = `${origin}/auth/email/verify?token=${t}`;

  if (env.RESEND_API_KEY) {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: env.EMAIL_FROM || "The Bay <login@thebay.events>",
        to: email,
        subject: "Your sign-in link for The Bay",
        html: `<p>Tap to sign in to <b>The Bay</b>:</p><p><a href="${link}">Sign in</a></p><p>This link expires in 15 minutes.</p>`,
      }),
    }).catch(() => {});
    return {};
  }
  return { devLink: link }; // no email provider configured → surface for dev/testing
}

/** Consume a magic-link token; returns the email if valid & unused, else null. */
export async function verifyMagicLink(env: Env, t: string): Promise<string | null> {
  const hash = await sha256hex(t);
  const row = await env.DB
    .prepare("SELECT email, expires_at, used FROM magic_links WHERE token_hash = ?")
    .bind(hash)
    .first<{ email: string; expires_at: string; used: number }>();
  if (!row || row.used || new Date(row.expires_at).getTime() < Date.now()) return null;
  await env.DB.prepare("UPDATE magic_links SET used = 1 WHERE token_hash = ?").bind(hash).run();
  return row.email;
}
