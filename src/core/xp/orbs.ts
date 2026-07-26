import { decodeBbox } from "../geohash";

/**
 * XP orbs — the collectibles floating on the map. PURE and deterministic, with NO
 * storage: `orbsForCell(cell, epoch)` derives the same orbs for every client from a
 * hash of the cell + a time epoch, so the map agrees without a spawn table. Orbs
 * refresh each epoch; a pickup is verified + deduped server-side (see routes/orbs).
 */
export const ORB_EPOCH_MS = 30 * 60 * 1000; // orbs refresh every 30 minutes
export const ORB_XP = [10, 15, 25, 50] as const; // tiers — rarer draw = more XP
export const PICKUP_RADIUS_M = 60; // you must be within ~60m to collect

export interface Orb {
  id: string; // `${cell}:${epoch}:${index}` — self-describing, so pickup can re-derive it
  cell: string;
  epoch: number;
  lat: number;
  lng: number;
  xp: number;
}

/** The current orb epoch for a timestamp. */
export function epochFor(nowMs: number): number {
  return Math.floor(nowMs / ORB_EPOCH_MS);
}

/** FNV-1a 32-bit — cheap, stable, seeds every orb from its (cell, epoch, index). */
function hash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** The orbs alive in a geohash cell during an epoch (1-3), positioned inside its bbox. */
export function orbsForCell(cell: string, epoch: number): Orb[] {
  const b = decodeBbox(cell);
  const count = 1 + (hash(`${cell}:${epoch}`) % 3); // 1..3
  const orbs: Orb[] = [];
  for (let i = 0; i < count; i++) {
    const h = hash(`${cell}:${epoch}:${i}`);
    const fx = (h & 0xffff) / 0xffff;
    const fy = ((h >>> 16) & 0xffff) / 0xffff;
    orbs.push({
      id: `${cell}:${epoch}:${i}`,
      cell,
      epoch,
      lat: b.minLat + fy * (b.maxLat - b.minLat),
      lng: b.minLng + fx * (b.maxLng - b.minLng),
      xp: ORB_XP[h % ORB_XP.length]!,
    });
  }
  return orbs;
}

/** Re-derive an orb from its id (for server-side pickup verification). Null if the id
 *  is malformed or its index is past that cell/epoch's spawn count. */
export function findOrb(orbId: string): Orb | null {
  const parts = orbId.split(":");
  if (parts.length !== 3) return null;
  const [cell, epochStr, idxStr] = parts;
  const epoch = Number(epochStr);
  const idx = Number(idxStr);
  if (!cell || !Number.isInteger(epoch) || !Number.isInteger(idx) || idx < 0) return null;
  return orbsForCell(cell, epoch)[idx] ?? null;
}
