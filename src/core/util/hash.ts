/**
 * Pure, dependency-free hashing (no node:crypto) so `core/` stays portable to
 * any runtime. Not cryptographic — used only for dedup fingerprints and cache
 * keys. cyrb53 is a well-regarded 53-bit string hash; we run it with two seeds
 * and concatenate to get ~106 bits, making accidental collisions negligible
 * across the tens-of-thousands of events this app handles.
 */
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function hash128(str: string): string {
  const a = cyrb53(str, 0).toString(16).padStart(14, "0");
  const b = cyrb53(str, 1).toString(16).padStart(14, "0");
  return a + b;
}
