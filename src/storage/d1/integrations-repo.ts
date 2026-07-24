import type { D1Database } from "@cloudflare/workers-types";
import { ulid } from "ulid";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const nowIso = () => new Date().toISOString();

export type Provider = "luma" | "eventbrite" | "meetup" | "calendar" | "linkedin" | "telegram";
export interface ImportItem {
  externalId: string;
  kind: string; // 'event' | 'connection'
  payload: unknown;
}

/**
 * IntegrationsRepo — per-user integration accounts + a generic dedup'd import
 * store. Every provider (Luma/Eventbrite/Meetup/Calendar/LinkedIn/Telegram) funnels
 * imported records through `importItems`, which is idempotent on
 * (user, provider, external_id) so re-imports never duplicate.
 */
export class IntegrationsRepo {
  constructor(private db: D1Database) {}

  async connectAccount(userId: string, provider: Provider, token: unknown): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO integration_accounts (user_id, provider, token_json, connected_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, provider) DO UPDATE SET token_json=excluded.token_json, connected_at=excluded.connected_at`,
      )
      .bind(userId, provider, JSON.stringify(token ?? {}), nowIso())
      .run();
  }
  async disconnect(userId: string, provider: Provider): Promise<void> {
    await this.db.prepare("DELETE FROM integration_accounts WHERE user_id=? AND provider=?").bind(userId, provider).run();
  }
  async listAccounts(userId: string): Promise<Array<{ provider: string; connectedAt: string }>> {
    const res = await this.db
      .prepare("SELECT provider, connected_at AS connectedAt FROM integration_accounts WHERE user_id=? ORDER BY connected_at DESC")
      .bind(userId)
      .all<Row>();
    return (res.results ?? []) as any;
  }

  /** Insert new items; returns how many were actually new (idempotent). */
  async importItems(userId: string, provider: Provider, items: ImportItem[]): Promise<number> {
    let inserted = 0;
    for (const it of items) {
      const r = await this.db
        .prepare(
          `INSERT OR IGNORE INTO imported_items (id, user_id, provider, external_id, kind, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(ulid(), userId, provider, it.externalId, it.kind, JSON.stringify(it.payload ?? {}), nowIso())
        .run();
      inserted += (r as any).meta?.changes ?? 0;
    }
    return inserted;
  }
  async listImported(userId: string, provider?: Provider): Promise<Array<{ externalId: string; kind: string; payload: unknown }>> {
    const stmt = provider
      ? this.db.prepare("SELECT external_id, kind, payload_json FROM imported_items WHERE user_id=? AND provider=? ORDER BY created_at DESC").bind(userId, provider)
      : this.db.prepare("SELECT external_id, kind, payload_json FROM imported_items WHERE user_id=? ORDER BY created_at DESC").bind(userId);
    const res = await stmt.all<Row>();
    return (res.results ?? []).map((r) => ({ externalId: r.external_id, kind: r.kind, payload: JSON.parse(r.payload_json || "{}") }));
  }
}
