// EFFECTS — Gate 0, WP2.
//
// What an operation MEANT to do, what it TRIED to do, what a handler SAID it
// did, and what Governor actually SAW change. Four different facts, and
// collapsing them is how a receipt comes to assert a vault state nobody
// checked.
//
// The distinction that does the most work is the last two. A handler returning
// `{filesChanged: 40}` is a CLAIM by the code that just ran; an observed
// effect is a fact Governor established by looking afterwards. This repo
// already learned the difference the expensive way — `obsidian_repoint_link`
// names one target and then discovers, rewrites and reports a set of its own,
// and the journal had to grow an `effects` field precisely because the
// argument-derived record described a one-file operation that may have changed
// forty.
//
// So: `reported` is retained as the handler's claim, labelled as such, and it
// never becomes `observed` by being plausible.

/** What kind of thing changed. */
export const EFFECT_KINDS = [
  "note-content",
  "note-path",
  "note-created",
  "note-deleted",
  "frontmatter",
  "attachment",
  "plugin-state",
  "external",
  "standing",
] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

export interface EffectTarget {
  kind: EffectKind;
  /** Vault-relative path, when the effect has one. */
  path: string | null;
  /** Stable identity, when known — a path is a location, not an identity. */
  identity?: string | null;
  /** Content digest AFTER the effect, when Governor observed it. */
  digest?: string | null;
}

/**
 * How settled an effect is.
 *
 * `uncertain` is the one that matters: the operation exceeded its deadline and
 * was abandoned while the underlying work may still be running, so the vault
 * may or may not have changed. Calling that `failed` would invite a retry that
 * duplicates a write which actually landed.
 */
export const SETTLEMENT = ["intended", "attempted", "reported", "observed", "uncertain", "corrected"] as const;
export type Settlement = (typeof SETTLEMENT)[number];

export interface EffectRecordV1 {
  schema: "governor.effect/v1";
  /**
   * Stable record identity.
   *
   * `corrects` referenced a millisecond TIMESTAMP in the first draft, which
   * made correction identity collide-prone: two records written in the same
   * tick share an `at`, so a correction naming one would silently exclude the
   * other — dropping an unrelated record's evidence with no error. Synchronous
   * handler code producing two records in one millisecond is ordinary, not
   * exotic.
   */
  id: string;
  operationId: string;
  settlement: Settlement;
  at: number;
  targets: EffectTarget[];
  /**
   * Present only on `reported`: the handler's own claim, verbatim, so a
   * reviewer can see what the code said as distinct from what was checked.
   */
  claimedBy?: "handler";
  /** Present on `corrected`: the id of the record this supersedes. */
  corrects?: string;
  /** Why an effect is uncertain, in the operation's own terms. */
  reason?: string;
}

export interface BuildEffectInput {
  id: string;
  operationId: string;
  settlement: Settlement;
  at: number;
  targets: EffectTarget[];
  corrects?: string;
  reason?: string;
}

export function buildEffect(input: BuildEffectInput): EffectRecordV1 {
  if (input.settlement === "corrected" && input.corrects === undefined) {
    throw new Error("a corrected effect must name the settlement it supersedes; a correction with no antecedent is just another claim");
  }
  if (input.settlement === "uncertain" && !input.reason) {
    throw new Error("an uncertain effect must say why; 'uncertain' with no reason gives a reader nothing to act on");
  }
  return {
    schema: "governor.effect/v1",
    id: input.id,
    operationId: input.operationId,
    settlement: input.settlement,
    at: input.at,
    targets: input.targets.map((t) => ({ ...t })),
    ...(input.settlement === "reported" ? { claimedBy: "handler" as const } : {}),
    ...(input.corrects !== undefined ? { corrects: input.corrects } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

/**
 * Reconcile what was intended, attempted, reported and observed into what a
 * receipt may CLAIM.
 *
 * The rules, in order, and each exists because the alternative lies:
 *
 *   • an `uncertain` settlement dominates everything. If the operation may
 *     still be running, no earlier evidence entitles anyone to say it did or
 *     did not land.
 *   • OBSERVED effects are the answer whenever they exist. They are the only
 *     kind Governor established by looking.
 *   • otherwise the answer is what was ATTEMPTED, and it is labelled
 *     unverified. A handler's report is retained beside it as a claim and
 *     never promoted — `filesChanged: 40` is what the code said, and the
 *     difference between that and forty files having changed is the whole
 *     point of keeping them apart.
 */
export interface EffectSummary {
  /** What a receipt may state as fact. */
  effects: EffectTarget[];
  /** Where that came from. */
  basis: "observed" | "attempted-unverified" | "uncertain" | "none";
  /** The handler's own claim, when it made one. Never merged into `effects`. */
  handlerClaimed: EffectTarget[] | null;
  reason?: string;
}

export function summarizeEffects(records: EffectRecordV1[]): EffectSummary {
  const bySettlement = (s: Settlement) => records.filter((r) => r.settlement === s);

  // A correction supersedes what it names, so an uncertain settlement that has
  // been corrected is no longer the live answer.
  const corrected = new Set(records.filter((r) => r.corrects !== undefined).map((r) => r.corrects!));
  const live = records.filter((r) => !corrected.has(r.id));

  const uncertain = live.filter((r) => r.settlement === "uncertain");
  // Deliberately over ALL records, not `live`, unlike every other bucket here.
  // This is the audit trail of what the code ever CLAIMED, and a claim that was
  // later superseded is still a thing the handler said — hiding it would make
  // the record of "what did this tool tell us?" depend on how the story ended.
  // It never enters `effects`, so it cannot be mistaken for a fact.
  const handlerClaimed = bySettlement("reported").flatMap((r) => r.targets);
  const claim = handlerClaimed.length > 0 ? handlerClaimed : null;

  if (uncertain.length > 0) {
    return { effects: [], basis: "uncertain", handlerClaimed: claim, reason: uncertain[0]!.reason };
  }
  // Keyed on the PRESENCE of an observation record, not on it having produced
  // targets. A late-error correction — an abandoned operation that turns out
  // to have changed nothing — is a `corrected` record with an EMPTY target
  // list, and it is the most authoritative statement available. Testing
  // `targets.length > 0` treated that identically to "no observation exists"
  // and fell through to report a stale, already-superseded `attempted` claim
  // as if the correction had never happened — which is exactly the collapsing
  // of facts this module exists to prevent.
  const observedRecords = live.filter((r) => r.settlement === "observed" || r.settlement === "corrected");
  if (observedRecords.length > 0) {
    return { effects: observedRecords.flatMap((r) => r.targets), basis: "observed", handlerClaimed: claim };
  }

  const attemptedRecords = live.filter((r) => r.settlement === "attempted");
  if (attemptedRecords.length > 0) {
    return { effects: attemptedRecords.flatMap((r) => r.targets), basis: "attempted-unverified", handlerClaimed: claim };
  }

  return { effects: [], basis: "none", handlerClaimed: claim };
}
