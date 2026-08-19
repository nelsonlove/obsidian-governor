// ============================================================================
//  AUTO-ACCEPT — the eligibility PREDICATE (pure; no `obsidian` import)
// ----------------------------------------------------------------------------
//  `evaluate(baseline, current, ctx)` is the single decision: may this pending,
//  agent-attributed change advance the baseline WITHOUT a human gesture?
//
//  It returns eligible ONLY when BOTH hold:
//   (A) CONJUNCTIVE-PER-WRITE — the ENTIRE diff partitions cleanly into changes
//       each covered by an ENABLED allowlisted detector, with NO residual. A write
//       that mixes a mechanical stamp with ANY other content edit is NOT eligible;
//       the whole write stays pending. A mechanical class can never smuggle content
//       past review. ONE additional partition EXISTS only under an honored per-note
//       `auto-accept: appends` policy (#261): an appended body TAIL — bytes strictly
//       extending the (identical or healed-only) existing body — counts as covered,
//       by the policy rather than a class. The conjunctive rule itself is unchanged:
//       every non-tail difference must still be class-attributed, an edit inside
//       existing content is still residual, and no policy-less write gets the tail
//       partition.
//   (B) RAIL-CLEAN — the change introduces no new conformance finding. The four
//       authorized classes are rail-neutral BY CONSTRUCTION (see classes.ts); a
//       future non-neutral class MUST supply a real railCheck result via the seam
//       below or it can never be eligible.
//
//  Eligibility is computed ONLY from the objective bytes (baseline vs current) and,
//  for link-heal, the rename index. It reads NO agent-supplied field — not the
//  journal `intent`, not any advisory text. That is grep-provable: this module and
//  detectors.ts never import or reference `intent`.
//
//  FAIL-SAFE: any exception, any doubt, a missing rename index, an unrecognized
//  change → NOT eligible → the change stays pending. Auto-accept only ever REDUCES
//  the human's queue for provably-mechanical changes; it never risks content.
//
//  Ported verbatim from obsidian-stewardship/src/auto-accept/eligibility.ts (#83, cycle 1).
//  This is the eligibility ENGINE — a pure predicate over bytes. It advances no baseline
//  itself and is wired to no MCP tool, plugin instance, or `app` this cycle; the accept
//  path that would consult it folds in under cycle 2's accept-reachability review.
// ============================================================================

import { parseNote } from "../frontmatter.js";
import {
  AUTHORIZED_CLASSES,
  specFor,
  type ClassId,
  type ClassSpec,
} from "./classes.js";
import {
  evaluateFrontmatter,
  evaluateBodyWithAppend,
  evaluateLinkHeal,
  type RenameIndex,
} from "./detectors.js";
import { isAppendOnly } from "./append-only.js";
import type { AutoAcceptPolicy } from "../protected-policy.js";

export type { RenameIndex } from "./detectors.js";

// A real rail-clean result for a FUTURE non-rail-neutral class. `clean:false` (or an absent
// hook for a non-neutral class) → not eligible.
export interface RailResult {
  clean: boolean;
  findings?: string[];
}

export interface RailClassResult {
  class: ClassId;
  clean: boolean;
  byConstruction: boolean; // true → rail-neutral class; no rail run needed
  findings?: string[];
}

export interface RailSummary {
  clean: boolean;
  results: RailClassResult[];
}

export interface EvalContext {
  enabled: ReadonlyArray<ClassId> | ReadonlySet<ClassId>;
  renameIndex?: RenameIndex | null;
  // Pluggable rail-clean hook for FUTURE non-rail-neutral classes. The four authorized classes
  // are rail-neutral and never consult this. If a non-neutral class is ever added, it MUST be
  // cleared here (a clean:true result) or it stays ineligible — the engine refuses to accept a
  // matched class that is neither rail-neutral nor rail-cleared.
  railCheck?: (cls: ClassId, base: string, cur: string) => RailResult;
  /**
   * The per-note auto-accept policy (#135/#224) — the HUMAN's delegation for
   * THIS note. MUST be the HONORED value (the caller derives it from the
   * blessed BASELINE frontmatter via `autoAcceptPolicyOf`, never from the raw
   * current note — honor-only-if-blessed): `appends` accepts a change iff the
   * baseline is a byte-prefix of the current content (the #226 detector, same
   * conservative discipline), or — since #261 — iff the diff COMPOSES as
   * allowlisted mechanical classes plus an appended body tail (see the header:
   * the tail is one extra partition, nothing else is loosened — a write that
   * appends AND modifies anything non-mechanical still stays pending); `all`
   * accepts any pending agent-attributed change. Absent/null ⇒ class-allowlist
   * evaluation only, byte-identical to the pre-#135 behavior.
   */
  policy?: AutoAcceptPolicy | null;
}

export interface EvalResult {
  eligible: boolean;
  classes: ClassId[];      // matched classes for this write (sorted, canonical order)
  reason: string;          // machine-ish reason (for logs / debugging)
  rail: RailSummary | null;
  /** The per-note policy that drove an eligible result, when one did (absent for class-driven accepts). */
  policy?: AutoAcceptPolicy;
}

function toSet(e: ReadonlyArray<ClassId> | ReadonlySet<ClassId>): Set<ClassId> {
  return e instanceof Set ? new Set(e) : new Set([...(e as ReadonlyArray<ClassId>)]);
}

const FENCE = "---";

// The RAW opening and closing frontmatter fence lines (verbatim, WITH any trailing whitespace), or
// null when the content has no frontmatter. `parseNote` recognizes a fence via `line.trim() ===
// "---"` and then DISCARDS the fence lines, so trailing whitespace on a fence (`---   `) is invisible
// to the frontmatter/body diff. We surface the exact fence bytes here so the eligibility path can
// assert them unchanged — a fence-byte delta is a non-mechanical change (residual → stay PENDING).
function fenceLines(content: string): { open: string | null; close: string | null } {
  if (!content.startsWith(FENCE)) return { open: null, close: null };
  const lines = content.split("\n");
  if (lines[0].trim() !== FENCE) return { open: null, close: null };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FENCE) return { open: lines[0], close: lines[i] };
  }
  return { open: null, close: null };
}

function canonicalize(classes: Set<ClassId>): ClassId[] {
  return AUTHORIZED_CLASSES.filter((s) => classes.has(s.id)).map((s) => s.id);
}

// The rail gate, factored out so it is unit-testable with a synthetic (non-authorized) spec
// registry — proving a FUTURE non-neutral class is refused unless railCheck returns clean.
export function evaluateRail(
  classes: ReadonlyArray<ClassId>,
  base: string,
  cur: string,
  ctx: Pick<EvalContext, "railCheck">,
  specFn: (id: ClassId) => ClassSpec = specFor,
): RailSummary {
  const results: RailClassResult[] = [];
  let clean = true;
  for (const cls of classes) {
    const spec = specFn(cls);
    if (spec.railNeutral) {
      results.push({ class: cls, clean: true, byConstruction: true });
      continue;
    }
    // Non-neutral class → MUST be cleared by a real rail check.
    if (!ctx.railCheck) {
      results.push({ class: cls, clean: false, byConstruction: false, findings: ["no-rail-check-for-non-neutral-class"] });
      clean = false;
      continue;
    }
    let r: RailResult;
    try {
      r = ctx.railCheck(cls, base, cur);
    } catch {
      r = { clean: false, findings: ["rail-check-threw"] };
    }
    results.push({ class: cls, clean: r.clean === true, byConstruction: false, findings: r.findings });
    if (r.clean !== true) clean = false;
  }
  return { clean, results };
}

export function evaluate(base: string, cur: string, ctx: EvalContext): EvalResult {
  const notEligible = (reason: string, rail: RailSummary | null = null): EvalResult =>
    ({ eligible: false, classes: [], reason, rail });

  try {
    if (typeof base !== "string" || typeof cur !== "string") return notEligible("bad-input");
    if (base === cur) return notEligible("no-change");

    // Per-note policy branch (#135) — BEFORE the class allowlist, and
    // independent of it (a human's per-note delegation does not require any
    // mechanical class to be enabled). `ctx.policy` is the HONORED (blessed)
    // policy only; see EvalContext. `appends` that does not pass the byte-prefix
    // detector falls THROUGH to class evaluation — a pure uid-stamp on a
    // policy-carrying note still auto-accepts by class, and (#261) the class
    // evaluation below COMPOSES with the policy: a change that is allowlisted
    // mechanical classes PLUS an appended body tail is eligible, where either
    // half alone already would be. (The live #261 wedge: a `modified:` stamp +
    // rename-driven link rewrites landed between the blessing and the appends,
    // so byte-prefix failed AND the class path refused the appended tail —
    // each half provably fine, the combination stuck pending forever.)
    if (ctx.policy === "all") {
      return { eligible: true, classes: [], reason: "policy-all", rail: null, policy: "all" };
    }
    const appendsPolicy = ctx.policy === "appends";
    if (appendsPolicy && isAppendOnly(base, cur)) {
      return { eligible: true, classes: [], reason: "policy-appends", rail: null, policy: "appends" };
    }

    const enabled = toSet(ctx.enabled);
    if (enabled.size === 0) return notEligible("allowlist-empty");

    const bp = parseNote(base);
    const cp = parseNote(cur);

    // FENCE INTEGRITY (closes the last residual): parseNote normalizes fences via `.trim()` and
    // discards them, so trailing whitespace on the opening/closing `---` would ride invisibly. If
    // the current note has frontmatter, its fence bytes must be UNCHANGED from baseline — or, when
    // the change legitimately CREATES the frontmatter block (baseline had none, e.g. a first uid
    // stamp), the new fences must be exactly canonical "---" with no trailing bytes. Any fence-byte
    // delta is a non-mechanical change → residual → stay PENDING.
    const bf = fenceLines(base);
    const cf = fenceLines(cur);
    if (cf.open !== null) {
      if (bf.open !== null) {
        if (bf.open !== cf.open || bf.close !== cf.close) return notEligible("fence-changed");
      } else if (cf.open !== FENCE || cf.close !== FENCE) {
        return notEligible("fence-noncanonical");
      }
    }

    // BODY: byte-identical, or ONLY confirmed link-heals (if enabled + index present) — and,
    // under an honored `appends` policy (#261), optionally PLUS an appended tail after the
    // (identical or healed-only) existing content. The strict evaluator stays in force for
    // class-only notes: an appended tail is residual there.
    const bodyEnabled = new Set<ClassId>(enabled);
    const bodyIndex = bodyEnabled.has("link-heal") ? ctx.renameIndex : null;
    const body = appendsPolicy
      ? evaluateBodyWithAppend(bp.body, cp.body, bodyIndex)
      : { ...evaluateLinkHeal(bp.body, cp.body, bodyIndex), appended: false };
    if (!body.ok) return notEligible(`body:${body.reason}`);

    // FRONTMATTER: every FM difference attributed to an enabled class, no residual.
    const fm = evaluateFrontmatter(bp.frontmatterText, cp.frontmatterText, enabled);
    if (!fm.ok) return notEligible(`fm:${fm.reason}`);

    // Combine matched classes.
    const matched = new Set<ClassId>(fm.classes);
    if (body.healed) matched.add("link-heal");
    const appended = body.appended === true;

    // No matched class but bytes differ → an unexplained residual we could not attribute —
    // UNLESS the whole difference is an appended body tail under the appends policy (only
    // reachable when frontmatter changed in a way classes explain as "nothing", i.e. it is
    // identical; the pure whole-note byte-append normally exits via the fast path above).
    if (matched.size === 0) {
      if (appended) return { eligible: true, classes: [], reason: "policy-appends", rail: null, policy: "appends" };
      return notEligible("no-class-matched-residual");
    }

    // Defensive: every matched class must be enabled (attribution already enforces this).
    for (const c of matched) {
      if (!enabled.has(c)) return notEligible(`class-not-enabled:${c}`);
    }

    // RAIL-CLEAN gate.
    const classes = canonicalize(matched);
    const rail = evaluateRail(classes, base, cur, ctx);
    if (!rail.clean) return notEligible("rail-not-clean", rail);

    // The policy is recorded on the result iff it did real work (covered the appended tail);
    // a pure class-accept on a policy-carrying note stays a class accept, as before.
    return appended
      ? { eligible: true, classes, reason: "policy-appends+classes", rail, policy: "appends" }
      : { eligible: true, classes, reason: "ok", rail };
  } catch (e) {
    // Any thrown error → fail safe.
    return notEligible(`exception:${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
//  Audit record — LOUD + complete. Every auto-accept appends one of these.
// ---------------------------------------------------------------------------

export interface AutoAcceptRecord {
  event: "auto-accept";
  reason: "auto-accept";
  ts: string;
  path: string;
  fromHash: string;
  toHash: string;
  classes: ClassId[];
  railResult: RailSummary | null;
  /** The per-note policy that drove this accept (#135), when one did. Absent on class-driven accepts. */
  policy?: AutoAcceptPolicy;
}

export function autoAcceptRecord(args: {
  ts: string;
  path: string;
  fromHash: string;
  toHash: string;
  classes: ClassId[];
  railResult: RailSummary | null;
  policy?: AutoAcceptPolicy;
}): AutoAcceptRecord {
  return {
    event: "auto-accept",
    reason: "auto-accept",
    ts: args.ts,
    path: args.path,
    fromHash: args.fromHash,
    toHash: args.toHash,
    classes: args.classes,
    railResult: args.railResult,
    ...(args.policy ? { policy: args.policy } : {}),
  };
}
