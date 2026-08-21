// CANONICAL JSON — version-1 canonical serialization (WP3, D13; RFC 8785).
//
// Everything a signature or full-coverage check covers is first serialized
// here, so two producers computing "the same subject" MUST emit the same
// bytes. RFC 8785 (JSON Canonicalization Scheme) gives the rules: object keys
// sorted by UTF-16 code units, strings escaped exactly as ECMAScript
// `JSON.stringify` escapes them, no insignificant whitespace.
//
// The guide then narrows the VALUE DOMAIN below full JSON, which is what makes
// a small hand-rolled canonicalizer safe where a general one would be risky:
// version-1 manifests "contain no floating-point fields, encode integer counts
// as non-negative safe integers, and use explicit null where the schema
// requires an absence marker". So this module REFUSES anything outside that
// domain — floats, negatives, unsafe integers, NaN/Infinity, undefined,
// non-plain objects — rather than guessing at a serialization for it. RFC
// 8785's hardest cases are exactly the number serializations this domain
// excludes; refusing them is what keeps the remainder provably deterministic.
//
// Refusal is a stable, typed error (`noncanonical`) because callers treat it
// as a contract violation to surface, not an exception to swallow.

export type CanonicalValue =
  | string
  | boolean
  | null
  | number // non-negative safe integers only — enforced at runtime
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

/** Stable error identifier: the value lies outside the version-1 canonical domain. */
export class NoncanonicalValueError extends Error {
  readonly code = "noncanonical";
  constructor(
    /** JSON-pointer-ish path to the offending value, for the human reading the refusal. */
    readonly at: string,
    detail: string
  ) {
    super(`noncanonical value at ${at || "<root>"}: ${detail}`);
    this.name = "NoncanonicalValueError";
  }
}

/**
 * RFC 8785 canonical serialization of a version-1 manifest value.
 *
 * Deterministic by construction over the admitted domain: strings and the
 * literals delegate to `JSON.stringify` (whose string escaping RFC 8785
 * adopts), integers in the admitted range have exactly one ECMAScript
 * serialization, arrays keep caller order (element ORDER IS MEANING in a
 * canonical subject — the builders sort before serializing, and this layer
 * must not re-sort what a schema has deliberately ordered), and object keys
 * are sorted by UTF-16 code units per the RFC.
 */
export function canonicalize(value: unknown): string {
  return write(value, "");
}

function write(v: unknown, at: string): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
    case "boolean":
      return JSON.stringify(v);
    case "number":
      if (!Number.isSafeInteger(v) || v < 0) {
        throw new NoncanonicalValueError(
          at,
          `numbers in a version-1 manifest are non-negative safe integers; got ${String(v)}`
        );
      }
      return JSON.stringify(v);
    case "undefined":
      throw new NoncanonicalValueError(at, "undefined has no canonical form; the schema uses explicit null for absence");
    default:
      break;
  }
  if (Array.isArray(v)) {
    return `[${v.map((item, i) => write(item, `${at}/${i}`)).join(",")}]`;
  }
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      throw new NoncanonicalValueError(at, "only plain objects can be canonicalized");
    }
    // RFC 8785: property names sorted by UTF-16 code units — which is exactly
    // what JavaScript's default string comparison does, so a plain `<` compare
    // is the compliant sort (NOT localeCompare, which is locale-dependent).
    const keys = Object.keys(v as Record<string, unknown>).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const parts = keys.map((k) => {
      const child = (v as Record<string, unknown>)[k];
      if (child === undefined) {
        throw new NoncanonicalValueError(`${at}/${k}`, "undefined property; omit the key or use explicit null");
      }
      return `${JSON.stringify(k)}:${write(child, `${at}/${k}`)}`;
    });
    return `{${parts.join(",")}}`;
  }
  throw new NoncanonicalValueError(at, `no canonical form for ${typeof v}`);
}
