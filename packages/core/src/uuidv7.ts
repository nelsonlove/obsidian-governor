// UUIDv7 (RFC 9562) — the one implementation.
//
// Originated in packages/plugin/src/mcp/write-notes-compose.ts, moved to
// packages/plugin/src/kernel/uuidv7.ts when the governance contracts became
// its second consumer (WP3 requires UUIDv7 for newly minted session, mandate,
// proposal, cohort, replica, and key-registration ids), and promoted here into
// @vault-mcp/core (S3, condition 9) because the governance provider imported
// it from the host at two call sites (governor/kernel/contracts/ids.ts,
// governor/kernel/gesture.ts) — a host module the provider must publish as a
// contract or copy. Forking the mint would eventually give the vault two
// subtly different uid formats, so it lives in the one place both the host
// and the provider can depend on without crossing the host/governor line.
// Byte-identical to the original.
//
// The 48-bit big-endian millisecond timestamp is the caller's `ms` — for note
// uids that is the note's `created` (so uids sort by authorship time), for
// governance ids it is mint time. Version (7) and variant (10) bits are set per
// RFC 9562; the remaining 74 bits are random. Randomness is injected so the
// mint is deterministic under test.

function defaultRandomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // Renderer + Node 18+ both expose a Web Crypto `crypto.getRandomValues`.
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(out);
  else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** A UUIDv7 whose timestamp field is `ms`. `rand` (≥10 bytes) is injectable for deterministic tests. */
export function uuidv7(ms: number, rand?: Uint8Array): string {
  const r = rand ?? defaultRandomBytes(10);
  const b = new Uint8Array(16);
  const t = Math.max(0, Math.floor(ms));
  b[0] = Math.floor(t / 2 ** 40) & 0xff;
  b[1] = Math.floor(t / 2 ** 32) & 0xff;
  b[2] = Math.floor(t / 2 ** 24) & 0xff;
  b[3] = Math.floor(t / 2 ** 16) & 0xff;
  b[4] = Math.floor(t / 2 ** 8) & 0xff;
  b[5] = t & 0xff;
  for (let i = 0; i < 10; i++) b[6 + i] = r[i] ?? 0;
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
