/**
 * Offline pack installation into OPFS (the Origin Private File System).
 *
 * "Download the Bay (412 MB)" → resumable, chunked HTTP Range reads written
 * straight to disk → the same map component reads tiles out of the local file
 * instead of R2. Nothing is buffered in memory: each chunk streams from the
 * network into a FileSystemWritableFileStream at a byte offset.
 *
 * ── The hard constraint, surfaced rather than hidden ─────────────────────────
 * OPFS is quota'd per origin, and on iOS Safari that quota lands near ~1 GB with
 * genuine eviction under storage pressure — so a pack larger than that simply
 * will not install there, and `preflight()` says so BEFORE the user spends their
 * data plan. We read the real number from `navigator.storage.estimate()` rather
 * than sniffing the UA, and we call `navigator.storage.persist()` to move the
 * origin out of "best effort" eviction where the browser allows it.
 *
 * Because installs are chunked and resumable, a partial install degrades
 * gracefully: whatever arrived is on disk, `installed()` reports it honestly, and
 * a later `installPack()` picks up at that byte offset.
 *
 * ── The native escape hatch ─────────────────────────────────────────────────
 * `capacitor.config.ts` wraps this exact web build into store apps. In the native
 * shell the quota does not apply: @capacitor/filesystem writing to
 * Directory.Data (iOS Application Support / Android files dir) is limited only by
 * free space, and a native HTTP downloader can resume the same way. The seam is
 * deliberately narrow — swap the `PackStore` implementation below and everything
 * above it (progress, resume, the pmtiles FileSource) is unchanged.
 */
import { FileSource, setPmtilesSource } from "../features/map/pmtiles";

/** 8 MiB. Big enough that per-request overhead vanishes, small enough that an
 *  interrupted install loses at most 8 MiB of progress. */
export const CHUNK_BYTES = 8 * 1024 * 1024;
const DIR = "packs";

export interface PackRef { id: string; bytes: number; url: string; etag?: string }

export interface InstalledPack {
  id: string;
  /** Bytes actually on disk right now. */
  installedBytes: number;
  /** Expected total, from the sidecar written at install start (0 if unknown). */
  totalBytes: number;
  complete: boolean;
}

export type InstallPhase = "preflight" | "downloading" | "verifying" | "done" | "cancelled" | "error";

export interface InstallProgress {
  id: string;
  phase: InstallPhase;
  receivedBytes: number;
  totalBytes: number;
  /** What is genuinely left to transfer — resume means this is NOT total − 0. */
  remainingBytes: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
  error?: string;
}

export class PackTooLargeError extends Error {
  constructor(readonly needBytes: number, readonly availableBytes: number) {
    super(
      `This pack needs ${fmtBytes(needBytes)} but your browser will only give this site ${fmtBytes(availableBytes)}. ` +
      `On iOS Safari the per-origin limit is around 1 GB — install the smaller z15 pack, or use the native app.`,
    );
    this.name = "PackTooLargeError";
  }
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n, i = -1;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function opfsSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;
}

async function packsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

/* ── storage budget ──────────────────────────────────────────────────────────*/
export interface StorageStatus {
  persisted: boolean;
  usageBytes: number;
  quotaBytes: number;
  freeBytes: number;
  supported: boolean;
}

export async function storageStatus(): Promise<StorageStatus> {
  if (!opfsSupported()) return { persisted: false, usageBytes: 0, quotaBytes: 0, freeBytes: 0, supported: false };
  const est = await navigator.storage.estimate().catch(() => ({ usage: 0, quota: 0 }));
  const usageBytes = est.usage ?? 0;
  const quotaBytes = est.quota ?? 0;
  const persisted = await navigator.storage.persisted?.().catch(() => false) ?? false;
  return { persisted, usageBytes, quotaBytes, freeBytes: Math.max(0, quotaBytes - usageBytes), supported: true };
}

/** Ask the browser to stop treating our data as evictable. Best-effort by design
 *  — Safari usually says no, which is precisely why partial installs must work. */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  try { return await navigator.storage.persist(); } catch { return false; }
}

/**
 * Can this pack land here? Returns what's missing instead of throwing so the UI
 * can grey the button out with a real number in the tooltip.
 */
export async function preflight(pack: PackRef): Promise<{ ok: boolean; alreadyBytes: number; needBytes: number; freeBytes: number; reason?: string }> {
  if (!opfsSupported()) return { ok: false, alreadyBytes: 0, needBytes: pack.bytes, freeBytes: 0, reason: "This browser has no Origin Private File System, so packs can't be stored offline." };
  const existing = await installed(pack.id);
  const alreadyBytes = existing?.installedBytes ?? 0;
  const needBytes = Math.max(0, pack.bytes - alreadyBytes);
  const { freeBytes } = await storageStatus();
  if (needBytes > freeBytes) {
    return { ok: false, alreadyBytes, needBytes, freeBytes, reason: new PackTooLargeError(needBytes, freeBytes).message };
  }
  return { ok: true, alreadyBytes, needBytes, freeBytes };
}

/* ── the store ───────────────────────────────────────────────────────────────*/
const metaName = (id: string) => `${id}.meta.json`;

export async function installed(id: string): Promise<InstalledPack | null> {
  if (!opfsSupported()) return null;
  try {
    const dir = await packsDir();
    const file = await (await dir.getFileHandle(id)).getFile();
    let totalBytes = 0;
    try {
      const meta = JSON.parse(await (await (await dir.getFileHandle(metaName(id))).getFile()).text()) as { bytes?: number };
      totalBytes = meta.bytes ?? 0;
    } catch { /* no sidecar — treat the file as authoritative */ }
    return { id, installedBytes: file.size, totalBytes, complete: totalBytes > 0 && file.size >= totalBytes };
  } catch { return null; }
}

export async function listInstalled(): Promise<InstalledPack[]> {
  if (!opfsSupported()) return [];
  const dir = await packsDir();
  const out: InstalledPack[] = [];
  // `values()` is an async iterator on FileSystemDirectoryHandle; it isn't in
  // lib.dom yet, hence the narrow cast rather than an `any` on the handle.
  const iter = (dir as unknown as { values(): AsyncIterableIterator<FileSystemHandle> }).values();
  for await (const entry of iter) {
    if (entry.kind !== "file" || entry.name.endsWith(".meta.json")) continue;
    const info = await installed(entry.name);
    if (info) out.push(info);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

export async function removePack(id: string): Promise<void> {
  if (!opfsSupported()) return;
  const dir = await packsDir();
  await dir.removeEntry(id).catch(() => undefined);
  await dir.removeEntry(metaName(id)).catch(() => undefined);
}

/**
 * Install (or resume) a pack. Reports real transferred bytes and real remaining
 * bytes — on a resume the progress bar starts where the disk already is, because
 * telling someone they have 412 MB to go when 300 MB is already local is a lie.
 */
export async function installPack(
  pack: PackRef,
  opts: { onProgress?: (p: InstallProgress) => void; signal?: AbortSignal } = {},
): Promise<InstalledPack> {
  const emit = (phase: InstallPhase, received: number, extra: Partial<InstallProgress> = {}) => {
    opts.onProgress?.({
      id: pack.id, phase,
      receivedBytes: received, totalBytes: pack.bytes,
      remainingBytes: Math.max(0, pack.bytes - received),
      bytesPerSecond: 0, etaSeconds: null,
      ...extra,
    });
  };

  emit("preflight", 0);
  const pre = await preflight(pack);
  if (!pre.ok) {
    emit("error", pre.alreadyBytes, { error: pre.reason });
    throw new PackTooLargeError(pre.needBytes, pre.freeBytes);
  }
  await requestPersistence();

  const dir = await packsDir();
  const handle = await dir.getFileHandle(pack.id, { create: true });
  await writeMeta(dir, pack);

  let offset = (await handle.getFile()).size;
  if (offset > pack.bytes) { // a stale/short pack under the same id — start over
    const w = await handle.createWritable({ keepExistingData: false });
    await w.close();
    offset = 0;
  }

  const startedAt = Date.now();
  const startedAtBytes = offset;
  const rate = () => {
    const secs = (Date.now() - startedAt) / 1000;
    return secs > 0.5 ? (offset - startedAtBytes) / secs : 0;
  };

  while (offset < pack.bytes) {
    if (opts.signal?.aborted) { emit("cancelled", offset); throw new DOMException("install cancelled", "AbortError"); }
    const length = Math.min(CHUNK_BYTES, pack.bytes - offset);
    const res = await fetch(pack.url, {
      headers: { range: `bytes=${offset}-${offset + length - 1}` },
      signal: opts.signal,
      cache: "no-store", // the pack is immutable; don't also keep it in the HTTP cache
    });
    if (res.status !== 206 && res.status !== 200) throw new Error(`pack download failed: HTTP ${res.status}`);

    // One writable per chunk: closing flushes, which is what makes resume real —
    // a crash costs at most this chunk, never the whole 400 MB.
    const writable = await handle.createWritable({ keepExistingData: true });
    let position = offset;
    try {
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writable.write({ type: "write", position, data: value });
          position += value.byteLength;
          const bps = rate();
          opts.onProgress?.({
            id: pack.id, phase: "downloading",
            receivedBytes: position, totalBytes: pack.bytes,
            remainingBytes: Math.max(0, pack.bytes - position),
            bytesPerSecond: bps,
            etaSeconds: bps > 0 ? Math.round((pack.bytes - position) / bps) : null,
          });
        }
      } else {
        const buf = await res.arrayBuffer();
        await writable.write({ type: "write", position, data: buf });
        position += buf.byteLength;
      }
    } finally {
      await writable.close();
    }
    if (position <= offset) throw new Error("pack download stalled (server returned no bytes)");
    offset = position;
  }

  emit("verifying", offset);
  const finalSize = (await handle.getFile()).size;
  if (finalSize !== pack.bytes) throw new Error(`pack size mismatch: expected ${pack.bytes}, on disk ${finalSize}`);
  emit("done", finalSize, { bytesPerSecond: rate() });
  return { id: pack.id, installedBytes: finalSize, totalBytes: pack.bytes, complete: true };
}

async function writeMeta(dir: FileSystemDirectoryHandle, pack: PackRef): Promise<void> {
  const h = await dir.getFileHandle(metaName(pack.id), { create: true });
  const w = await h.createWritable({ keepExistingData: false });
  await w.write(JSON.stringify({ bytes: pack.bytes, etag: pack.etag ?? null, url: pack.url, at: new Date().toISOString() }));
  await w.close();
}

/** The installed pack as a `File`, or null. `File.slice()` is a lazy view, which
 *  is what lets the PMTiles reader byte-range it without loading 400 MB. */
export async function openInstalledFile(id: string): Promise<File | null> {
  if (!opfsSupported()) return null;
  try { return await (await (await packsDir()).getFileHandle(id)).getFile(); } catch { return null; }
}

/**
 * Point the map's `pmtiles://<name>` source at the LOCAL copy. Returns false if
 * the pack isn't fully installed, in which case the caller keeps streaming from
 * R2 — offline is an upgrade, never a prerequisite.
 */
export async function attachOfflinePack(name: string, id: string): Promise<boolean> {
  const info = await installed(id);
  if (!info?.complete) return false;
  const file = await openInstalledFile(id);
  if (!file) return false;
  setPmtilesSource(name, new FileSource(file, `opfs:${id}`));
  return true;
}
