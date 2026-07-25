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
  /**
   * "People you may know" — imported connections (kind='connection') whose email
   * matches a Bay member, minus yourself and anyone you already have a friendship
   * with (pending, accepted, or blocked). Case-insensitive on email; de-duplicated
   * per member even if imported from several providers/rows. Opted-out (private)
   * members are excluded. Returns the member to connect with plus the provider and
   * the name the CSV knew them by, for UI context.
   */
  async suggestionsFromImports(
    userId: string,
  ): Promise<Array<{ id: string; displayName: string; handle: string; provider: string; matchedName: string | null }>> {
    const res = await this.db
      .prepare(
        `SELECT u.id, u.display_name AS displayName, u.handle,
                MIN(ii.provider) AS provider,
                MIN(json_extract(ii.payload_json, '$.name')) AS matchedName
           FROM imported_items ii
           JOIN users u ON lower(u.email) = lower(json_extract(ii.payload_json, '$.email'))
          WHERE ii.user_id = ?
            AND ii.kind = 'connection'
            AND coalesce(json_extract(ii.payload_json, '$.email'), '') <> ''
            AND u.id <> ?
            AND u.social_enabled = 1
            AND NOT EXISTS (
              SELECT 1 FROM friendships f
               WHERE (f.user_low = ? AND f.user_high = u.id)
                  OR (f.user_low = u.id AND f.user_high = ?)
            )
          GROUP BY u.id, u.display_name, u.handle
          ORDER BY u.display_name`,
      )
      .bind(userId, userId, userId, userId)
      .all<Row>();
    return (res.results ?? []).map((r) => ({
      id: r.id,
      displayName: r.displayName,
      handle: r.handle,
      provider: r.provider,
      matchedName: r.matchedName ?? null,
    }));
  }

  async listImported(userId: string, provider?: Provider): Promise<Array<{ externalId: string; kind: string; payload: unknown }>> {
    const stmt = provider
      ? this.db.prepare("SELECT external_id, kind, payload_json FROM imported_items WHERE user_id=? AND provider=? ORDER BY created_at DESC").bind(userId, provider)
      : this.db.prepare("SELECT external_id, kind, payload_json FROM imported_items WHERE user_id=? ORDER BY created_at DESC").bind(userId);
    const res = await stmt.all<Row>();
    return (res.results ?? []).map((r) => ({ externalId: r.external_id, kind: r.kind, payload: JSON.parse(r.payload_json || "{}") }));
  }
}
