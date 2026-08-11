// Small, dependency-free content hash. FNV-1a (64-bit) rendered hex.
// Not cryptographic — used only to cheaply decide "did this note's content change
// vs its stored baseline". Collisions are astronomically unlikely for this use and,
// if one ever occurred, would at worst fail to surface a diff (never mis-accept).
//
// Ported verbatim from obsidian-stewardship/src/hash.ts as part of the governance
// (Acceptance) module fold (#83, cycle 1). Pure logic only — no vault, no accept surface.

export function contentHash(s: string): string {
  // 64-bit FNV-1a implemented with BigInt for portability.
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i) & 0xff);
    // Also fold in the high byte of any multibyte char so unicode changes register.
    const hi = s.charCodeAt(i) >> 8;
    if (hi) h ^= BigInt(hi) << 8n;
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}
