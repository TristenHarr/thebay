/**
 * The browser half of PMTiles: byte sources, gzip, directory caching, and the
 * MapLibre `pmtiles://` protocol. All the decoding is pure and lives in
 * `src/core/maps/pmtiles.ts` (and is unit-tested there).
 *
 * WHY THIS EXISTS AT ALL: the map used to pull raster PNGs cross-origin from
 * tile.openstreetmap.org, which (a) can't be restyled — so no dark high-contrast
 * look — and (b) can't be cached by our service worker, which scopes to `/app/`.
 * PMTiles fixes both: one immutable vector archive in R2, read with HTTP Range
 * (src/worker/routes/maps.ts) or straight off the local OPFS copy once the pack is
 * installed — the SAME map component either way.
 *
 * It's hand-written rather than `npm i pmtiles` on purpose: owning the source
 * abstraction is what lets a `FileSource` over an OPFS handle be a first-class
 * citizen instead of a shim.
 */
import {
  PMTILES_HEADER_BYTES, parsePmtilesDirectory, parsePmtilesHeader, resolveTile, zxyToTileId,
  type Compression, type DirEntry, type PmtilesHeader,
} from "../../../../src/core/maps/pmtiles";

export type { PmtilesHeader } from "../../../../src/core/maps/pmtiles";

/* ── byte ranges come from the network or from the local disk ─────────────────*/
export interface RangeSource {
  /** Stable identity, used for cache keys and diagnostics. */
  readonly key: string;
  getBytes(offset: number, length: number, signal?: AbortSignal): Promise<ArrayBuffer>;
}

/** HTTP Range against `/tiles/:pack`. The Worker answers 206 and the edge caches
 *  each slice, so repeat views of the same area never reach R2. */
export class FetchSource implements RangeSource {
  readonly key: string;
  constructor(private url: string) { this.key = url; }
  async getBytes(offset: number, length: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    const res = await fetch(this.url, { headers: { range: `bytes=${offset}-${offset + length - 1}` }, signal });
    if (res.status !== 206 && res.status !== 200) throw new Error(`pmtiles: ${this.url} returned ${res.status}`);
    return res.arrayBuffer();
  }
}

/** The offline path: a pack installed in OPFS. `File.slice()` is a lazy view, so
 *  this reads exactly the requested bytes off disk — a 400 MB pack is never in RAM. */
export class FileSource implements RangeSource {
  readonly key: string;
  constructor(private file: File, key?: string) { this.key = key ?? `opfs:${file.name}`; }
  async getBytes(offset: number, length: number): Promise<ArrayBuffer> {
    return this.file.slice(offset, offset + length).arrayBuffer();
  }
}

async function decompress(buf: ArrayBuffer, how: Compression): Promise<ArrayBuffer> {
  if (how === "none" || how === "unknown") return buf;
  if (how !== "gzip") throw new Error(`pmtiles: ${how} compression is not available in the browser`);
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/** Leaf directories are ~4 KB each; 64 of them covers a lot of panning. */
const LEAF_CACHE_MAX = 64;
/** A PMTiles archive nests at most a couple of levels; this is a loop fuse. */
const MAX_DIR_DEPTH = 4;

export class PMTiles {
  private header: PmtilesHeader | null = null;
  private root: DirEntry[] | null = null;
  private leaves = new Map<string, DirEntry[]>();
  private opening: Promise<PmtilesHeader> | null = null;

  constructor(readonly source: RangeSource) {}

  /** Header + root directory, fetched once. De-duplicated because MapLibre asks
   *  for a dozen tiles on first paint and must not trigger a dozen header reads. */
  async open(): Promise<PmtilesHeader> {
    if (this.header) return this.header;
    if (!this.opening) {
      this.opening = (async () => {
        const head = parsePmtilesHeader(await this.source.getBytes(0, PMTILES_HEADER_BYTES));
        const raw = await this.source.getBytes(head.rootDirOffset, head.rootDirLength);
        this.root = parsePmtilesDirectory(await decompress(raw, head.internalCompression));
        this.header = head;
        return head;
      })().catch((e: unknown) => { this.opening = null; throw e; });
    }
    return this.opening;
  }

  async metadata(): Promise<unknown> {
    const h = await this.open();
    if (!h.metadataLength) return {};
    const raw = await this.source.getBytes(h.metadataOffset, h.metadataLength);
    const text = new TextDecoder().decode(await decompress(raw, h.internalCompression));
    try { return JSON.parse(text) as unknown; } catch { return {}; }
  }

  /** Decompressed tile bytes, or null for a legitimately absent tile (ocean,
   *  outside the extract) — which must NOT surface as an error. */
  async getTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<ArrayBuffer | null> {
    const h = await this.open();
    if (z < h.minZoom || z > h.maxZoom) return null;
    const tileId = zxyToTileId(z, x, y);

    let dir = this.root!;
    for (let depth = 0; depth < MAX_DIR_DEPTH; depth++) {
      const step = resolveTile(h, dir, tileId);
      if (step.kind === "absent") return null;
      if (step.kind === "tile") return decompress(await this.source.getBytes(step.offset, step.length, signal), h.tileCompression);
      const key = `${step.offset}:${step.length}`;
      let leaf = this.leaves.get(key);
      if (!leaf) {
        leaf = parsePmtilesDirectory(await decompress(await this.source.getBytes(step.offset, step.length, signal), h.internalCompression));
        if (this.leaves.size >= LEAF_CACHE_MAX) {
          const oldest = this.leaves.keys().next().value;
          if (oldest !== undefined) this.leaves.delete(oldest);
        }
        this.leaves.set(key, leaf);
      }
      dir = leaf;
    }
    return null;
  }
}

/* ── MapLibre glue ───────────────────────────────────────────────────────────*/
const archives = new Map<string, PMTiles>();

/** Point `pmtiles://<name>/…` at a source. Calling it again with the same name
 *  swaps the streamed R2 pack for the local OPFS one — the map keeps rendering. */
export function setPmtilesSource(name: string, source: RangeSource): PMTiles {
  const archive = new PMTiles(source);
  archives.set(name, archive);
  return archive;
}
export function getPmtilesArchive(name: string): PMTiles | undefined { return archives.get(name); }
export function pmtilesSourceKey(name: string): string | null { return archives.get(name)?.source.key ?? null; }

/** The `tiles:` entry a MapLibre vector source needs. */
export const pmtilesTileUrl = (name: string) => `pmtiles://${name}/{z}/{x}/{y}`;

interface ProtocolHost {
  addProtocol(name: string, fn: (params: { url: string }, abort: AbortController) => Promise<{ data: ArrayBuffer | null }>): void;
}

let registered = false;
/** Idempotently teach MapLibre the `pmtiles://` scheme. */
export function registerPmtilesProtocol(maplibre: ProtocolHost): void {
  if (registered) return;
  registered = true;
  maplibre.addProtocol("pmtiles", async (params, abort) => {
    const m = /^pmtiles:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!m) throw new Error(`bad pmtiles url ${params.url}`);
    const archive = archives.get(m[1]!);
    if (!archive) throw new Error(`no pmtiles source registered as "${m[1]}"`);
    // MapLibre renders nothing for a null body, which is exactly right for ocean.
    return { data: await archive.getTile(Number(m[2]), Number(m[3]), Number(m[4]), abort.signal) };
  });
}
