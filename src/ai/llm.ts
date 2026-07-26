/**
 * Unified chat-completion helper. Prefers the user's own OpenRouter key
 * (bring-your-own AI), falls back to Workers AI, and returns null when neither is
 * available so the caller can use its deterministic output. Pure except for the
 * network call; `buildOpenRouterRequest` is exported so the request shape is
 * testable without hitting the network.
 */
export interface ChatMsg { role: "system" | "user" | "assistant"; content: string }
export interface LlmEnv { AI?: { run(model: string, input: unknown): Promise<any> } }
export interface ChatOpts {
  openrouterKey?: string | null;
  model?: string | null;
  maxTokens?: number;
  env?: LlmEnv;
  /** Abort after this long. A slow model must degrade, never hold a request open. */
  timeoutMs?: number;
  /** Ask for `response_format: json_object`. Structured callers set this. */
  json?: boolean;
  /** Omitted ⇒ the provider default. Structured callers pass 0. */
  temperature?: number;
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini";
const WORKERS_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";

/** The exact HTTP request we send to OpenRouter — separated out so tests can
 *  assert the auth header + body without a live call. */
export function buildOpenRouterRequest(messages: ChatMsg[], opts: ChatOpts): { url: string; init: RequestInit } {
  const body: Record<string, unknown> = {
    model: opts.model || DEFAULT_OPENROUTER_MODEL,
    messages,
    max_tokens: opts.maxTokens ?? 220,
  };
  if (opts.json) body.response_format = { type: "json_object" };
  if (opts.temperature != null) body.temperature = opts.temperature;
  return {
    url: OPENROUTER_URL,
    init: {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.openrouterKey}`,
        "content-type": "application/json",
        "HTTP-Referer": "https://thebay.events",
        "X-Title": "The Bay",
      },
      body: JSON.stringify(body),
    },
  };
}

export async function chatComplete(messages: ChatMsg[], opts: ChatOpts): Promise<string | null> {
  if (opts.openrouterKey) {
    // AbortController rather than Promise.race: race leaks the in-flight request,
    // and on a Worker that keeps the isolate alive past the response.
    const ctl = opts.timeoutMs ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), opts.timeoutMs) : null;
    try {
      const { url, init } = buildOpenRouterRequest(messages, opts);
      const res = await fetch(url, ctl ? { ...init, signal: ctl.signal } : init);
      if (!res.ok) return null;
      const j: any = await res.json();
      const text = j?.choices?.[0]?.message?.content?.trim();
      return text || null;
    } catch { return null; } finally { if (timer) clearTimeout(timer); }
  }
  if (opts.env?.AI) {
    try {
      const r = await opts.env.AI.run(WORKERS_AI_MODEL, { messages, max_tokens: opts.maxTokens ?? 220 });
      const text = (r?.response || "").trim();
      return text || null;
    } catch { return null; }
  }
  return null;
}
