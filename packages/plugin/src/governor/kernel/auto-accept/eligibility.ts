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
//       past review. (The per-note policy partitions — `all`, and #261's appended
//       tail under `appends` — were DELETED in WP10c per guide §654: `all` outright,
//       `appends` migrated to content proposals. No frontmatter value widens
//       eligibility; an appended tail is residual like any other content.)
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
//  WP10c REASSESSMENT (guide §654, 2026-08-25): this engine survives ONLY for
//  the pre-cutover / post-rollback legacy era — post-cutover its writer refuses
//  and the poll no longer runs the sweep. None of its classes carries automatic
//  authority into the admission era; a class that deserves a future automatic
//  life returns as a REGISTERED TRANSFORMATION (transformations/) through its
//  own review, with promotion evidence from zero.
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
  evaluateLinkHeal,
  type RenameIndex,
} from "./detectors.js";

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
}

export interface EvalResult {
  eligible: boolean;
  classes: ClassId[];      // matched classes for this write (sorted, canonical order)
  reason: string;          // machine-ish reason (for logs / debugging)
  rail: RailSummary | null;
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

    // The per-note policy branches are DELETED (WP10c, guide §654): `all`
    // was a whole-note blank check and is gone outright; `appends` migrated
    // to content proposals — an appended tail is residual here, exactly like
    // any other content, and lands as an ordinary proposal for the human's
    // decision. Eligibility is the reviewed mechanical classes ALONE; no
    // frontmatter value widens it. (#261's composition machinery went with
    // the policy — its wedge cannot recur, because nothing waits on a
    // policy-accept anymore.)
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

    // BODY: byte-identical, or ONLY confirmed link-heals (if enabled + index
    // present). An appended tail is residual — content proposes (WP10c).
    const bodyEnabled = new Set<ClassId>(enabled);
    const bodyIndex = bodyEnabled.has("link-heal") ? ctx.renameIndex : null;
    const body = evaluateLinkHeal(bp.body, cp.body, bodyIndex);
    if (!body.ok) return notEligible(`body:${body.reason}`);

    // FRONTMATTER: every FM difference attributed to an enabled class, no residual.
    const fm = evaluateFrontmatter(bp.frontmatterText, cp.frontmatterText, enabled);
    if (!fm.ok) return notEligible(`fm:${fm.reason}`);

    // Combine matched classes.
    const matched = new Set<ClassId>(fm.classes);
    if (body.healed) matched.add("link-heal");

    // No matched class but bytes differ → an unexplained residual we could
    // not attribute. Stays PENDING; a human (or the admission era's proposal
    // path) decides.
    if (matched.size === 0) {
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

    return { eligible: true, classes, reason: "ok", rail };
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
  /** HISTORICAL only: the policy that drove a pre-WP10c policy-accept. Never produced anymore; kept so old log records still parse and render. */
  policy?: "appends" | "all";
}

export function autoAcceptRecord(args: {
  ts: string;
  path: string;
  fromHash: string;
  toHash: string;
  classes: ClassId[];
  railResult: RailSummary | null;
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
  };
}
