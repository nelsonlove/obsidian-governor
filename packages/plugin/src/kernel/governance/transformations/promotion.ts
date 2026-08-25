// PROMOTION EVIDENCE — the gate between "eligible" and "automatic" (WP10;
// D02, D14; sessions-mandates-and-cohorts.md line 136).
//
// "Automatic admission is enabled only after the same transformation,
// verifier, and recovery path have passed the required live evidence gate."
// That sentence is this file. The TUPLE is exact — transformation id AND
// version, the canonical verifier set, the recovery unit — and evidence for
// any other tuple is evidence for nothing here: a new verifier version
// restarts the clock, which is the point of separately versioned verifiers.
//
// Evidence is FACTS, recorded automatically from real admissions and
// reverts; promotion is a HUMAN ACT on top of the facts — gesture-gated,
// like every other authority grant. The split matters: facts accumulate
// without anyone deciding anything, and the decision cannot be made where
// the facts are missing (`promote` refuses NAMING what is absent — an
// unmet gate must never render as an empty result; the week's recurring
// bug, designed out rather than tested out).
//
// Required evidence classes, per tuple, before promotion is even offerable:
//   * ≥1 individual-admit  — the pilot: a human admitted one result of this
//     exact tuple and looked at it.
//   * ≥1 cohort-admit      — the scale shape: a human admitted a verified
//     cohort of this tuple in one decision.
//   * ≥1 revert            — the recovery drill: the reversal path was
//     EXERCISED, not asserted. A recovery method nobody has run is a claim.
//
// Demotion is the one-click brake: gestured, recorded, and immediate —
// after it, the tuple is unpromoted until a human promotes again (the
// evidence record survives; distrust of the DECISION is not amnesia about
// the facts).

export interface PromotionTuple {
  transformationId: string;
  transformationVersion: string;
  /** Canonical verifier identity: sorted, comma-joined `id@version` list. Use verifierKeyOf — never hand-build. */
  verifier: string;
  recoveryUnit: "item" | "cohort";
}

/** The canonical verifier string — order-independent, so two spellings of one set are one identity. */
export function verifierKeyOf(predicates: Array<{ id: string; version: string }>): string {
  return predicates
    .map((p) => `${p.id}@${p.version}`)
    .sort()
    .join(",");
}

/** The canonical tuple key. One string, one tuple, no near-misses. */
export function tupleKeyOf(t: PromotionTuple): string {
  return `${t.transformationId}@${t.transformationVersion}|${t.verifier}|${t.recoveryUnit}`;
}

export type EvidenceKind = "individual-admit" | "cohort-admit" | "revert";

export type PromotionEvent =
  | {
      kind: "evidence";
      at: number;
      tuple: PromotionTuple;
      evidence: {
        kind: EvidenceKind;
        /** What the evidence points at — a claim id, a cohort digest, a superseded proposal id. Never empty. */
        ref: string;
        memberCount?: number;
      };
    }
  | { kind: "promoted"; at: number; tuple: PromotionTuple; gestureRef: string; principal: string }
  | { kind: "demoted"; at: number; tuple: PromotionTuple; gestureRef: string; principal: string; reason: string };

export interface TupleState {
  tuple: PromotionTuple;
  counts: { individualAdmits: number; cohortAdmits: number; reverts: number };
  /** Present iff currently promoted. */
  promotedAt: number | null;
  promotedBy: string | null;
}

export class PromotionRefusedError extends Error {
  constructor(readonly code: "authority_missing" | "promotion_evidence_missing" | "not_promoted" | "already_promoted" | "evidence_invalid", detail: string) {
    super(detail);
    this.name = "PromotionRefusedError";
  }
}

/** Fold — session-store discipline: garbage skipped, unknown shapes ignored, one interpretation. */
export function foldPromotionEvents(lines: readonly string[]): Map<string, TupleState> {
  const out = new Map<string, TupleState>();
  const stateOf = (tuple: PromotionTuple): TupleState => {
    const key = tupleKeyOf(tuple);
    let s = out.get(key);
    if (!s) {
      s = { tuple, counts: { individualAdmits: 0, cohortAdmits: 0, reverts: 0 }, promotedAt: null, promotedBy: null };
      out.set(key, s);
    }
    return s;
  };
  for (const line of lines) {
    let ev: PromotionEvent;
    try {
      ev = JSON.parse(line) as PromotionEvent;
    } catch {
      continue;
    }
    try {
      if (!ev.tuple?.transformationId || !ev.tuple.transformationVersion || typeof ev.tuple.verifier !== "string" || !ev.tuple.recoveryUnit) continue;
      const s = stateOf(ev.tuple);
      if (ev.kind === "evidence") {
        if (ev.evidence.kind === "individual-admit") s.counts.individualAdmits++;
        else if (ev.evidence.kind === "cohort-admit") s.counts.cohortAdmits++;
        else if (ev.evidence.kind === "revert") s.counts.reverts++;
      } else if (ev.kind === "promoted") {
        s.promotedAt = ev.at;
        s.promotedBy = ev.principal;
      } else if (ev.kind === "demoted") {
        s.promotedAt = null;
        s.promotedBy = null;
      }
    } catch {
      // A malformed event never takes down the fold.
    }
  }
  return out;
}

export type PromotionVerdict =
  | { state: "promoted"; promotedAt: number; promotedBy: string }
  | {
      /** Not promoted — with the gate's own arithmetic SPOKEN: which evidence exists, which is missing. Absence never renders as emptiness. */
      state: "unpromoted";
      counts: TupleState["counts"];
      missing: string[];
    };

/** The evidence classes still missing for a tuple, [] when the gate is met. */
export function missingEvidenceOf(counts: TupleState["counts"]): string[] {
  const missing: string[] = [];
  if (counts.individualAdmits < 1) missing.push("individual-admit (pilot): a human has never admitted a single result of this exact tuple");
  if (counts.cohortAdmits < 1) missing.push("cohort-admit: a verified cohort of this tuple has never passed a one-gesture human decision");
  if (counts.reverts < 1) missing.push("revert (recovery drill): the reversal path has never been exercised on this tuple");
  return missing;
}

export function promotionVerdictOf(state: TupleState | null): PromotionVerdict {
  if (state === null) {
    return { state: "unpromoted", counts: { individualAdmits: 0, cohortAdmits: 0, reverts: 0 }, missing: missingEvidenceOf({ individualAdmits: 0, cohortAdmits: 0, reverts: 0 }) };
  }
  if (state.promotedAt !== null && state.promotedBy !== null) {
    return { state: "promoted", promotedAt: state.promotedAt, promotedBy: state.promotedBy };
  }
  return { state: "unpromoted", counts: { ...state.counts }, missing: missingEvidenceOf(state.counts) };
}

export interface PromotionEventIo {
  appendLine(line: string): Promise<void>;
  readLines(): Promise<string[]>;
}

export interface PromotionStore {
  /** Record one fact. Refuses an empty ref — evidence pointing at nothing is not evidence. */
  recordEvidence(tuple: PromotionTuple, evidence: { kind: EvidenceKind; ref: string; memberCount?: number }, now: number): Promise<void>;
  /** THE promotion act — human, gestured, refused with the NAMED missing evidence when the gate is unmet. */
  promote(tuple: PromotionTuple, gestureRef: string, principal: string, now: number): Promise<void>;
  /** The brake. Gestured; refuses when not promoted (nothing to demote is said, not swallowed). */
  demote(tuple: PromotionTuple, gestureRef: string, principal: string, reason: string, now: number): Promise<void>;
  verdictOf(tuple: PromotionTuple): Promise<PromotionVerdict>;
  all(): Promise<TupleState[]>;
}

export function createPromotionStore(io: PromotionEventIo): PromotionStore {
  let lines: string[] | null = null;

  async function allLines(): Promise<string[]> {
    if (lines === null) lines = await io.readLines();
    return lines;
  }

  async function state(): Promise<Map<string, TupleState>> {
    return foldPromotionEvents(await allLines());
  }

  async function append(ev: PromotionEvent): Promise<void> {
    const cached = await allLines();
    const line = JSON.stringify(ev);
    await io.appendLine(line);
    cached.push(line);
  }

  return {
    async recordEvidence(tuple, evidence, now) {
      if (!evidence.ref.trim()) throw new PromotionRefusedError("evidence_invalid", "evidence must reference the admission or revert it came from");
      await append({ kind: "evidence", at: now, tuple, evidence });
    },
    async promote(tuple, gestureRef, principal, now) {
      if (!gestureRef) throw new PromotionRefusedError("authority_missing", "promotion is a human gesture; no gestureRef was presented");
      if (!principal.trim()) throw new PromotionRefusedError("authority_missing", "promotion names its human principal");
      const verdict = promotionVerdictOf((await state()).get(tupleKeyOf(tuple)) ?? null);
      if (verdict.state === "promoted") {
        throw new PromotionRefusedError("already_promoted", `${tupleKeyOf(tuple)} is already promoted (by ${verdict.promotedBy})`);
      }
      if (verdict.missing.length > 0) {
        throw new PromotionRefusedError(
          "promotion_evidence_missing",
          `${tupleKeyOf(tuple)} cannot be promoted — the live evidence gate is unmet: ${verdict.missing.join("; ")}`
        );
      }
      await append({ kind: "promoted", at: now, tuple, gestureRef, principal });
    },
    async demote(tuple, gestureRef, principal, reason, now) {
      if (!gestureRef) throw new PromotionRefusedError("authority_missing", "demotion is a human gesture; no gestureRef was presented");
      const verdict = promotionVerdictOf((await state()).get(tupleKeyOf(tuple)) ?? null);
      if (verdict.state !== "promoted") {
        throw new PromotionRefusedError("not_promoted", `${tupleKeyOf(tuple)} is not promoted — nothing to demote`);
      }
      await append({ kind: "demoted", at: now, tuple, gestureRef, principal, reason });
    },
    async verdictOf(tuple) {
      return promotionVerdictOf((await state()).get(tupleKeyOf(tuple)) ?? null);
    },
    async all() {
      return [...(await state()).values()];
    },
  };
}
