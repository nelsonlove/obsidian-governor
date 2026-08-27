// SUBJECT V1 — canonical proposal-item and cohort subjects (WP3, D13).
//
// When Governor says an attestation covers a proposal or cohort, THIS is what
// it covers: a versioned canonical manifest, independent of Git commit
// serialization, hashed over the exact bytes `canonical-json.ts` emits. D13
// calls it what it is — "a security contract, not a convenience serializer".
// Every producer must compute the same subject bytes or signatures and
// full-coverage verification mean nothing.
//
// The serialized field names below are STABLE. TypeScript may rename nothing
// that appears on the wire. Any incompatible change creates
// `governor.proposal-item/v2` — `/v1` serialization is never changed in place.
//
// Builders sort; serialization preserves. The sort rules (guide §8) live in
// the builders because array ORDER IS MEANING once serialized — the
// canonicalizer deliberately refuses to re-order arrays.

import { canonicalize, digestUtf8, isSha256Digest, type Sha256Digest } from "@vault-mcp/core";
import { sortClasses, isChangeClass, type ChangeClass } from "./change-class.js";

export const PROPOSAL_ITEM_SCHEMA = "governor.proposal-item/v1";
export const COHORT_SCHEMA = "governor.cohort/v1";

// ── stable error identifiers ─────────────────────────────────────────────────
//
// Four, exactly as WP3 names them. `code` is the wire-stable identifier;
// message text may improve freely.

/** The input violates the subject schema. */
export class SubjectInvalidError extends Error {
  readonly code = "subject_invalid";
  constructor(detail: string) {
    super(`invalid subject: ${detail}`);
    this.name = "SubjectInvalidError";
  }
}

/** Two items claim the same identity; deduplicating silently is forbidden. */
export class SubjectDuplicateError extends Error {
  readonly code = "subject_duplicate";
  constructor(detail: string) {
    super(`duplicate subject identity: ${detail}`);
    this.name = "SubjectDuplicateError";
  }
}

/** The value cannot be canonically serialized (re-exported semantics; see canonical-json). */
export { NoncanonicalValueError } from "@vault-mcp/core";

/** The schema string names a version this build does not implement. */
export class SubjectUnsupportedVersionError extends Error {
  readonly code = "subject_unsupported_version";
  constructor(readonly schema: string) {
    super(`unsupported subject schema: ${schema}`);
    this.name = "SubjectUnsupportedVersionError";
  }
}

// ── wire shapes (serialized names are stable) ────────────────────────────────

export interface ProposalItemSubjectV1 {
  schema: typeof PROPOSAL_ITEM_SCHEMA;
  vaultId: string;
  noteId: string;
  /** Path only when required for display or when path/containment is part of the predicate. */
  path: string | null;
  pathSemanticallyRelevant: boolean;
  /** Null for a creation — explicit absence, not omission. */
  base: Sha256Digest | null;
  proposed: Sha256Digest;
  attachments: Array<{ id: string; digest: Sha256Digest }>;
  sideEffects: Array<{ kind: string; target: string; digest: Sha256Digest | null }>;
  changeClasses: ChangeClass[];
  transformation: { id: string; version: string };
  predicates: Array<{ id: string; version: string }>;
  producingOperation: { id: string; action: string; actionVersion: number };
  /** Ephemeral observations are rejected — they cannot support a proposal (D16). */
  observations: Array<{ id: string; digest: Sha256Digest; capture: "evidence" | "replayable" }>;
  sessionId: string;
  mandateId: string | null;
}

export interface CohortSubjectV1 {
  schema: typeof COHORT_SCHEMA;
  items: ProposalItemSubjectV1[];
  resolvedScope: { include: string[]; exclude: string[] };
  excludedProposalIds: string[];
  recoveryUnit: "item" | "cohort";
}

// ── builders ─────────────────────────────────────────────────────────────────

/**
 * Rebuild a digest as exactly `{algorithm, value}`. Digest inputs arrive from
 * fallible producers, and an extra property riding on one would land in the
 * canonical bytes — two producers describing the same content would then
 * compute different subject digests, which is the precise failure this
 * contract exists to prevent. Nothing passes through by reference.
 */
function cleanDigest(d: Sha256Digest): Sha256Digest {
  return { algorithm: "sha256", value: d.value };
}

export type ProposalItemInput = Omit<ProposalItemSubjectV1, "schema">;

/**
 * Build a canonical proposal-item subject: validate, sort, stamp the schema.
 * The input's array order is caller-arbitrary; the output's is canonical —
 * attachments by id, side effects by kind/target/digest, classes in the
 * six-class order, predicates by id then version, observations by id then
 * digest.
 */
export function buildProposalItemSubject(input: ProposalItemInput): ProposalItemSubjectV1 {
  requireNonEmptyString(input.vaultId, "vaultId");
  requireNonEmptyString(input.noteId, "noteId");
  if (input.path !== null) requireNonEmptyString(input.path, "path");
  requireBoolean(input.pathSemanticallyRelevant, "pathSemanticallyRelevant");
  if (input.base !== null && !isSha256Digest(input.base)) throw new SubjectInvalidError("base is not a sha256 digest");
  if (!isSha256Digest(input.proposed)) throw new SubjectInvalidError("proposed is not a sha256 digest");
  requireNonEmptyString(input.transformation?.id, "transformation.id");
  requireNonEmptyString(input.transformation?.version, "transformation.version");
  requireNonEmptyString(input.producingOperation?.id, "producingOperation.id");
  requireNonEmptyString(input.producingOperation?.action, "producingOperation.action");
  if (!Number.isSafeInteger(input.producingOperation?.actionVersion) || input.producingOperation.actionVersion < 1) {
    throw new SubjectInvalidError("producingOperation.actionVersion must be a positive integer");
  }
  requireNonEmptyString(input.sessionId, "sessionId");
  if (input.mandateId !== null) requireNonEmptyString(input.mandateId, "mandateId");

  // Array fields are checked BEFORE iteration so a structurally malformed
  // item — one missing `attachments` entirely, say — refuses with the stable
  // identifier instead of a raw TypeError from the spread. Same refusal
  // either way; only the error contract differs, and WP3 promises the code.
  requireArray(input.changeClasses, "changeClasses");
  requireArray(input.attachments, "attachments");
  requireArray(input.sideEffects, "sideEffects");
  requireArray(input.predicates, "predicates");
  requireArray(input.observations, "observations");

  for (const c of input.changeClasses) {
    if (!isChangeClass(c)) throw new SubjectInvalidError(`unknown change class: ${String(c)}`);
  }

  const attachments = [...input.attachments].map((a) => {
    requireNonEmptyString(a?.id, "attachments[].id");
    if (!isSha256Digest(a.digest)) throw new SubjectInvalidError(`attachment ${a.id}: digest is not a sha256 digest`);
    return { id: a.id, digest: cleanDigest(a.digest) };
  });
  attachments.sort((a, b) => cmp(a.id, b.id));
  rejectAdjacentDuplicates(attachments, (a) => a.id, "attachment id");

  const sideEffects = [...input.sideEffects].map((s) => {
    requireNonEmptyString(s?.kind, "sideEffects[].kind");
    requireNonEmptyString(s?.target, "sideEffects[].target");
    if (s.digest !== null && !isSha256Digest(s.digest)) {
      throw new SubjectInvalidError(`side effect ${s.kind}:${s.target}: digest is not a sha256 digest`);
    }
    return { kind: s.kind, target: s.target, digest: s.digest === null ? null : cleanDigest(s.digest) };
  });
  sideEffects.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.target, b.target) || cmp(a.digest?.value ?? "", b.digest?.value ?? ""));

  const predicates = [...input.predicates].map((p) => {
    requireNonEmptyString(p?.id, "predicates[].id");
    requireNonEmptyString(p?.version, "predicates[].version");
    return { id: p.id, version: p.version };
  });
  predicates.sort((a, b) => cmp(a.id, b.id) || cmp(a.version, b.version));

  const observations = [...input.observations].map((o) => {
    requireNonEmptyString(o?.id, "observations[].id");
    if (!isSha256Digest(o.digest)) throw new SubjectInvalidError(`observation ${o.id}: digest is not a sha256 digest`);
    // D16's dependency rule, enforced at the subject boundary too: an
    // ephemeral observation cannot support a proposal. The type says so, and
    // the runtime check catches the caller the type system cannot see.
    if (o.capture !== "evidence" && o.capture !== "replayable") {
      throw new SubjectInvalidError(`observation ${o.id}: capture level '${String(o.capture)}' cannot support a proposal`);
    }
    return { id: o.id, digest: cleanDigest(o.digest), capture: o.capture };
  });
  observations.sort((a, b) => cmp(a.id, b.id) || cmp(a.digest.value, b.digest.value));

  return {
    schema: PROPOSAL_ITEM_SCHEMA,
    vaultId: input.vaultId,
    noteId: input.noteId,
    path: input.path,
    pathSemanticallyRelevant: input.pathSemanticallyRelevant,
    base: input.base === null ? null : cleanDigest(input.base),
    proposed: cleanDigest(input.proposed),
    attachments,
    sideEffects,
    changeClasses: sortClasses(input.changeClasses),
    transformation: { id: input.transformation.id, version: input.transformation.version },
    predicates,
    producingOperation: {
      id: input.producingOperation.id,
      action: input.producingOperation.action,
      actionVersion: input.producingOperation.actionVersion,
    },
    observations,
    sessionId: input.sessionId,
    mandateId: input.mandateId,
  };
}

export interface CohortInput {
  items: ProposalItemSubjectV1[];
  resolvedScope: { include: string[]; exclude: string[] };
  excludedProposalIds: string[];
  recoveryUnit: "item" | "cohort";
}

/**
 * Build a canonical cohort subject. Items sort by noteId, then proposed
 * digest, then path with null before strings. Duplicate item identities are
 * REJECTED rather than silently deduplicated — a cohort that names the same
 * note twice is a construction error someone must see, because whichever copy
 * survived a silent dedup would be the one nobody chose.
 */
export function buildCohortSubject(input: CohortInput): CohortSubjectV1 {
  if (input.recoveryUnit !== "item" && input.recoveryUnit !== "cohort") {
    throw new SubjectInvalidError(`recoveryUnit must be "item" or "cohort", got ${String(input.recoveryUnit)}`);
  }

  // Items are REBUILT, not trusted. A TypeScript type does not bind a runtime
  // caller — an item parsed from JSON or hand-assembled would otherwise skip
  // every item-level rule (the review's proof: an ephemeral observation rode
  // straight through the cohort path). Rebuilding re-runs the full item
  // validation and re-sorts, and costs nothing for an already-canonical item.
  const items = input.items.map((it) => {
    if (it.schema !== PROPOSAL_ITEM_SCHEMA) throw new SubjectUnsupportedVersionError(String(it.schema));
    const { schema, ...rest } = it;
    void schema;
    return buildProposalItemSubject(rest);
  });

  // The guide's sort keys (noteId, proposed, path) are not total: two items
  // from different vaults can tie on all three, and a stable sort would then
  // preserve INPUT order — same item set, different canonical bytes, which is
  // the exact failure D13 defines this contract against. D13 requires "stable
  // identity plus deterministic tie-breaker", so vaultId closes the order.
  // No committed fixture digest changes: valid single-vault inputs never tie.
  items.sort(
    (a, b) =>
      cmp(a.noteId, b.noteId) || cmp(a.proposed.value, b.proposed.value) || cmpNullFirst(a.path, b.path) || cmp(a.vaultId, b.vaultId)
  );

  // Identity is the note within the vault: one frozen cohort holds at most one
  // proposed state per note. Checked over a set rather than adjacency —
  // duplicates of one vault's note can interleave with another vault's items
  // under the sort above, and the adjacency scan missed exactly that case.
  const seen = new Set<string>();
  for (const it of items) {
    const key = `${it.vaultId}\u0000${it.noteId}`;
    if (seen.has(key)) {
      throw new SubjectDuplicateError(`note ${it.noteId} (vault ${it.vaultId}) appears more than once in the cohort`);
    }
    seen.add(key);
  }

  const include = [...input.resolvedScope.include].sort(cmp);
  const exclude = [...input.resolvedScope.exclude].sort(cmp);
  const excludedProposalIds = [...input.excludedProposalIds].sort(cmp);
  rejectAdjacentDuplicates(
    excludedProposalIds.map((id) => ({ id })),
    (x) => x.id,
    "excluded proposal id"
  );

  return { schema: COHORT_SCHEMA, items, resolvedScope: { include, exclude }, excludedProposalIds, recoveryUnit: input.recoveryUnit };
}

// ── digesting ────────────────────────────────────────────────────────────────

/**
 * The digest an attestation covers: SHA-256 over the subject's canonical
 * serialization. Note CONTENT digests are computed from exact note bytes
 * elsewhere and arrive here already inside the manifest — this hashes the
 * manifest, never the notes.
 */
export function subjectDigest(subject: ProposalItemSubjectV1 | CohortSubjectV1): Sha256Digest {
  if (subject.schema !== PROPOSAL_ITEM_SCHEMA && subject.schema !== COHORT_SCHEMA) {
    throw new SubjectUnsupportedVersionError(String((subject as { schema: unknown }).schema));
  }
  return digestUtf8(canonicalize(subject));
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** UTF-16 code-unit comparison — the same order RFC 8785 sorts object keys by. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpNullFirst(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return cmp(a, b);
}

function requireNonEmptyString(v: unknown, field: string): asserts v is string {
  if (typeof v !== "string" || v.length === 0) throw new SubjectInvalidError(`${field} must be a non-empty string`);
}

function requireBoolean(v: unknown, field: string): asserts v is boolean {
  if (typeof v !== "boolean") throw new SubjectInvalidError(`${field} must be a boolean`);
}

function requireArray(v: unknown, field: string): asserts v is unknown[] {
  if (!Array.isArray(v)) throw new SubjectInvalidError(`${field} must be an array`);
}

function rejectAdjacentDuplicates<T>(sorted: readonly T[], key: (t: T) => string, what: string): void {
  for (let i = 1; i < sorted.length; i++) {
    if (key(sorted[i]) === key(sorted[i - 1])) throw new SubjectDuplicateError(`${what} '${key(sorted[i])}' appears twice`);
  }
}
