import { SqliteRepository } from "./sqlite/sqlite-repo";
import type { Repository } from "./repository";

/** Factory — swap this for a D1-backed impl when porting to Cloudflare. */
export function createRepository(path?: string): Repository {
  return new SqliteRepository(path);
}

export type { Repository } from "./repository";
export * from "./repository";
