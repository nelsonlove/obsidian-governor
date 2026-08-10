// finding.ts — the canonical conformance Finding and its stable 4-tuple key.
//
// Every rule pack (the module findings adapters + the ported legacy checks)
// emits this shape. The key is `(script, check, target, kind)` — deliberately
// free of line numbers, positional ordinals, counts, and timestamps, so a
// finding has the SAME identity across runs regardless of output ordering. This
// is the identity the ratchet diffs against the accepted-debt baseline.
//
// The serialized form is `script|check|target|kind` (pipe-joined), byte-
// identical to the Python ratchet's baseline lines (verified against the live
// `Conformance baseline.md` fence) so the existing accepted debt carries over
// with no re-blessing when the rail moves to TypeScript.
//
// `detail` is human-facing text (the "message" a reviewer reads); it is NOT
// part of the key — two findings that differ only in wording are the same
// finding.

export interface Finding {
  /** The rule pack that produced it, e.g. "vocab_findings", "conformance_check". */
  script: string;
  /** The check/code within the pack, e.g. "unregistered_tag", "DROPPED". */
  check: string;
  /** What the finding is about — a note path, or a token when the finding is
   * not note-scoped. */
  target: string;
  /** A secondary discriminant (a blueprint name, an offending token, "" when
   * the check needs none). */
  kind: string;
  /** Human-readable message; excluded from the key. */
  detail: string;
}

const SEP = "|";

/**
 * The stable key line for a finding: `script|check|target|kind`.
 *
 * `script`, `check`, and `target` must not contain the separator — a pipe in
 * one of the first three fields would mis-field the key on parse (only `kind`,
 * the last field, may contain a pipe since `parseKey` rejoins the remainder).
 * Vault paths and the packs' codes never contain a pipe; we throw rather than
 * emit a silently-mis-fielded key, mirroring the Python ratchet's RailError.
 */
export function findingKey(f: Pick<Finding, "script" | "check" | "target" | "kind">): string {
  for (const [name, val] of [["script", f.script], ["check", f.check], ["target", f.target]] as const) {
    if (val.includes(SEP)) {
      throw new Error(`conformance finding ${name} contains the reserved '|' separator: ${JSON.stringify(val)}`);
    }
  }
  return [f.script, f.check, f.target, f.kind].join(SEP);
}

/**
 * Parse a baseline/key line back into its four fields. Split into exactly four
 * fields: the first three separators delimit script/check/target, and
 * everything after the third is the kind — so a `kind` that itself contains a
 * pipe survives, and vault paths (which never contain a pipe) parse cleanly.
 */
export function parseKey(line: string): Pick<Finding, "script" | "check" | "target" | "kind"> {
  const parts = line.split(SEP);
  const [script = "", check = "", target = ""] = parts;
  const kind = parts.slice(3).join(SEP);
  return { script, check, target, kind };
}
