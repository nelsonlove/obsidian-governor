// DIGEST — SHA-256 over exact UTF-8 bytes (WP3, D13).
//
// The one rule that matters here is BYTE PRESERVATION: a note's content digest
// is the hash of exactly the bytes the note holds, never a normalized form.
// D13 makes the canonical subject a security contract — "signatures and
// full-coverage verification are meaningful only when every producer computes
// the same subject bytes" — and any normalization (Unicode NFC, newline
// folding, trailing-whitespace trims) would let two producers disagree about
// what was signed while both believe they hashed "the same" note.
//
// `node:crypto` is available in both runtimes this plugin has (the Node test
// runner and Obsidian's desktop renderer — the plugin is isDesktopOnly), which
// is what makes the committed cross-runtime fixture meaningful: both sides run
// the same implementation over the same bytes, and the fixture pins the
// output so a future runtime change is caught rather than absorbed.

import { createHash } from "node:crypto";

/** A SHA-256 digest as it appears inside canonical version-1 subjects. */
export interface Sha256Digest {
  algorithm: "sha256";
  /** 64 lowercase hexadecimal characters. */
  value: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Whether a value is a well-formed Sha256Digest. */
export function isSha256Digest(v: unknown): v is Sha256Digest {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Sha256Digest).algorithm === "sha256" &&
    typeof (v as Sha256Digest).value === "string" &&
    HEX64.test((v as Sha256Digest).value)
  );
}

/** SHA-256 of exact bytes. */
export function digestBytes(bytes: Uint8Array): Sha256Digest {
  return { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * SHA-256 of a string's exact UTF-8 encoding. No normalization of any kind —
 * composed and decomposed Unicode that render identically digest differently,
 * on purpose: they are different bytes, and the subject covers bytes.
 */
export function digestUtf8(text: string): Sha256Digest {
  return { algorithm: "sha256", value: createHash("sha256").update(text, "utf8").digest("hex") };
}
