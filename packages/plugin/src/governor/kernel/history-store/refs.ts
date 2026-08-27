// REFS — the internal ref namespace, behind one service (WP4, D08).
//
// D08 keeps Git ref names and namespace layout INTERNAL, versioned, with no
// compatibility guarantee — and adds the one external rule that matters: "No
// external tool should advance Governor refs directly." This module is the
// single place ref names are constructed, so nothing else in the codebase
// concatenates a ref string, and the repository interface exposes only
// compare-and-swap advancement over names built here.
//
// Every id that lands in a ref name is validated first. Refs are filesystem
// paths in a loose-ref store; an id carrying "../" or a control character
// would otherwise become a path-traversal primitive.

import { RefNameError } from "./types.js";

const NAMESPACE = "refs/governor";

/**
 * A component of a ref name: the characters our minted ids (UUIDv7, lowercase
 * hex) and schema-fixed kind names actually use. LOWERCASE ONLY — loose refs
 * are files, and on a case-insensitive filesystem (APFS, the primary target)
 * `proposals/ABC` and `proposals/abc` alias ONE file, so two logically
 * distinct ids differing only in case would silently share a ref. Nothing
 * mints uppercase today; this pins that nothing ever may. Trailing `.` and a
 * `.lock` suffix are git's own reserved forms — refusing them here keeps the
 * refusal typed instead of leaking isomorphic-git's InvalidRefNameError
 * through the contract.
 */
const COMPONENT = /^[a-z0-9][a-z0-9._-]*$/;

function component(v: string, what: string): string {
  if (!COMPONENT.test(v) || v.includes("..") || v.endsWith(".") || v.endsWith(".lock")) {
    throw new RefNameError(`${what} '${v}' cannot appear in a ref name`);
  }
  return v;
}

/** The admitted-standing ref for the vault. One per repository. */
export function standingRef(): string {
  return `${NAMESPACE}/standing`;
}

/** The recording ref for one proposal's snapshots. */
export function proposalRef(proposalId: string): string {
  return `${NAMESPACE}/proposals/${component(proposalId, "proposal id")}`;
}

/** The recording ref for one frozen cohort. */
export function cohortRef(cohortId: string): string {
  return `${NAMESPACE}/cohorts/${component(cohortId, "cohort id")}`;
}

/** Whether a ref name lies inside Governor's internal namespace. */
export function isGovernorRef(ref: string): boolean {
  return ref === standingRef() || ref.startsWith(`${NAMESPACE}/`);
}
