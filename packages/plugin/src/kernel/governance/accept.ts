// ============================================================================
//  THE HARD SECURITY INVARIANT  (read before touching this file)
// ----------------------------------------------------------------------------
//  Ported from obsidian-stewardship/src/accept.ts as part of the governance
//  (Acceptance) module fold (#83, cycle 2). Obsidian-free by construction, so it is
//  headless-testable exactly as it was in Stewardship.
//
//  Accept, Revert AND Adopt-baseline are the powers that confer standing and
//  mutate the baseline (adopt mutates EVERY governed note's baseline at once —
//  it silences the whole queue). All three MUST only ever be reachable as DOM
//  click handlers on buttons (the review pane), each gated on `isRealGesture` so a
//  synthesized `.click()` cannot fire them, with adopt additionally behind a
//  human-confirmation modal. They must NOT be:
//    - registered as an Obsidian command (addCommand) — vault-mcp ships
//      `obsidian_run_command`, so any command is agent-invokable via
//      app.commands.executeCommandById(...). A command that reaches accept is a
//      self-approval primitive one prompt-injection away.
//    - exposed as a public plugin API method (plugin.api.accept = ...),
//    - registered as a URI handler (registerObsidianProtocolHandler),
//    - published as an MCP tool.
//
//  CLOSURE-CAPTURE REACHABILITY (the whole point).
//  TypeScript `private` is NOT runtime-private: a `private doAccept()` method is a
//  plain enumerable prototype method at runtime, so `app.plugins.plugins['vault-mcp']
//  .doAccept(path)` would work from ANY renderer-JS context (js-engine / execute-code
//  / meta-bind / quickadd all run arbitrary JS this vault loads). An agent can plant a
//  note via a normal MCP write whose embedded JS calls that method; if the human
//  renders it, it self-accepts — the exact "one prompt injection away from
//  self-approval" the design (Assent ch.5) forbids. Therefore accept/revert (and the
//  baseline-advance primitive, BaselineStore.setBaseline, which silences the queue and
//  is accept-equivalent) MUST NOT be reachable from any object a renderer-JS attacker
//  can walk from `app`:
//    - NO doAccept/doRevert/accept/revert/acceptDeps method or property on the
//      Plugin instance, its prototype, the ItemView instance, or anything stored on
//      app.workspace / a leaf / app.plugins.plugins['vault-mcp'].
//    - The BaselineStore lives in a module-scope WeakMap keyed by the plugin instance
//      (governance/wiring.ts `baselineStores`), NOT as `this.store`, so it is not an
//      enumerable own property of the plugin.
//    - accept/revert are performed by module-scope functions (governance/wiring.ts
//      performAccept/performRevert + these exported acceptNote/revertNote). The view
//      holds its deps in a module-scope WeakMap (governance/pane.ts `viewDeps`), never
//      as an instance field. The ONLY live reference to an accept-capable callable is
//      inside each pane button's addEventListener('click') closure, closed over the
//      specific already-displayed note row.
//  Net: the only way to accept is a real click on a real button in the pane.
//
//  This module therefore imports NOTHING from Obsidian and is never wired to a command.
//  It exports plain functions that the pane's button handlers call (through the
//  module-scope performAccept/performRevert closures) directly. The tripwire
//  (tests/governance-module.test.mjs, tests/governance-accept.test.mjs) enforces that no
//  command/enumerable/MCP path reaches them.
// ============================================================================

import { acceptanceStatusOf, missingRequiredKeys, parseNote, frontmatterKeys } from "./frontmatter.js";
import type { Baseline } from "./baseline-store.js";

export interface AcceptStore {
  get(path: string): Baseline | null;
  setBaseline(path: string, content: string, by: string, at?: string): Promise<Baseline>;
}

export interface StewardshipLogRecord {
  action: "accept" | "revert";
  path: string;
  ts: string;
  by: string;
  stamped?: boolean;
  quarantine?: string;
  hash?: string;
}

// D2 — a silent baseline advance (the human-edit classify path, or a self-baseline
// settle) mutates the baseline WITHOUT the human clicking Accept. Accept/revert already
// log; this record makes a silent advance auditable after the fact so nothing mutates the
// baseline off-audit. Appended to the same acceptance-log.jsonl.
export interface SilentAdvanceRecord {
  event: "silent-advance";
  ts: string;
  path: string;
  reason: "human-edit" | "self-baseline";
  fromHash: string | null; // prior baseline hash, or null if there was no baseline
  toHash: string;          // hash the baseline advanced to
  /** The D12 origin record backing this advance (WP5). Optional: pre-WP5 log lines lack it. */
  origin?: { origin: string; confidence: string };
}

// #101 — the request-changes / withdraw human dispositions log to the SAME
// acceptance-log.jsonl (uniform audit records for every disposition). Pure
// record shape only: the actions live in governance/wiring.ts as module-scope
// functions reached solely from gesture-gated pane handlers. Neither advances
// a baseline — they write the agent-legal `revising`/`proposed` transitions —
// but both confer standing ("a human asked for changes"), so they are audited.
export interface RevisionDispositionRecord {
  action: "request-changes" | "withdraw-request";
  path: string;
  ts: string;
  by: string;
}

// #284/#306 — a baseline RE-KEY: the note moved, so its acceptance was re-addressed to
// follow it. This advances nothing — `content`, `hash`, `acceptedAt`, `acceptedBy` cross
// verbatim — but the acceptance perimeter's own evidence store is being rewritten, and a
// repair that hides itself is indistinguishable from tampering. `hash` is recorded
// precisely so a reader can confirm it did NOT change.
export interface BaselineRekeyRecord {
  event: "baseline-rekey";
  ts: string;
  /** The path the baseline is keyed at now (so `path` means the same thing in every record). */
  path: string;
  from: string;
  to: string;
  /** The note identity the move was resolved on; null for the rename-event path, which
   * follows Obsidian's own move rather than matching on uid. */
  uid: string | null;
  /** Unchanged by the move, by construction. Present so an auditor can verify that. */
  hash: string;
  /** Which half moved it: the observed rename, or the startup repair of drift nobody saw. */
  reason: "rename" | "reconcile";
}

export type LogRecord =
  | StewardshipLogRecord
  | SilentAdvanceRecord
  | RevisionDispositionRecord
  | BaselineRekeyRecord;

// Pure builder for the silent-advance audit record (kept pure so it is headless-testable
// and reused verbatim by wiring.ts's reconcile path).
export function silentAdvanceRecord(args: {
  ts: string;
  path: string;
  reason: SilentAdvanceRecord["reason"];
  fromHash: string | null;
  toHash: string;
  origin?: { origin: string; confidence: string };
}): SilentAdvanceRecord {
  return {
    event: "silent-advance",
    ts: args.ts,
    path: args.path,
    reason: args.reason,
    fromHash: args.fromHash,
    toHash: args.toHash,
    ...(args.origin ? { origin: args.origin } : {}),
  };
}

/** Pure builder for the baseline-rekey audit record. Kept pure for the same reason
 * `silentAdvanceRecord` is: the shape is the audit contract, and it is asserted headlessly. */
export function baselineRekeyRecord(args: {
  ts: string;
  from: string;
  to: string;
  uid: string | null;
  hash: string;
  reason: BaselineRekeyRecord["reason"];
}): BaselineRekeyRecord {
  return {
    event: "baseline-rekey",
    ts: args.ts,
    path: args.to,
    from: args.from,
    to: args.to,
    uid: args.uid,
    hash: args.hash,
    reason: args.reason,
  };
}

/** The exact fields the context-aware Accept stamps into a `proposed` note. `status` is the
 * LITERAL type "accepted": the shape structurally cannot express stamping any other value, so
 * even a buggy caller of the injected `stampAccepted` dep cannot mint a different family. */
export interface AcceptanceStampFields {
  status: "accepted";
  by: string; // the CONFIGURED human identity (governance config `acceptedBy`)
  on: string; // local minutes-precision timestamp, YYYY-MM-DDTHH:mm (the vault convention)
}

export interface AcceptDeps {
  readNote(path: string): Promise<string>;
  // Link-safe write of full content (vault.process in production).
  writeNote(path: string, content: string): Promise<void>;
  /** Write the accepted family into the note's frontmatter. In production this is the
   * module-scope `stampAcceptedFrontmatter` in governance/wiring.ts — Obsidian's own
   * `app.fileManager.processFrontMatter` — never exported, never a command/tool/method,
   * reached ONLY through this dep on the gesture-gated accept path. */
  stampAccepted(path: string, fields: AcceptanceStampFields): Promise<void>;
  store: AcceptStore;
  // Move `content` into the quarantine store; returns the quarantine file path. NEVER deletes.
  quarantine(path: string, content: string): Promise<string>;
  appendLog(record: StewardshipLogRecord): Promise<void>;
  now(): string;      // ISO timestamp (UTC) — log records + baseline acceptedAt
  nowLocal(): string; // local minutes-precision stamp for accepted-on (formatLocalMinutes)
  user: string;       // accepted-by identity (governance config `acceptedBy`)
  /** The conformance gate (#221/#164): frontmatter keys that must be present and non-empty
   * before a `proposed` note may be accepted. EMPTY (the default) ⇒ no gate. This is where
   * the legacy QuickAdd accept-macro's vault-specific checks (uid, title, description) live
   * now — as per-vault CONFIG, never hardcoded in the plugin. */
  requiredFrontmatterKeys: string[];
}

export interface AcceptResult { stamped: boolean; baseline: Baseline; }
export interface RevertResult { quarantine: string; restoredHash: string; }

/** The conformance-gate refusal: a `proposed` note is missing required frontmatter. Thrown
 * BEFORE any write — no stamp, no baseline advance, no log record (nothing happened). */
export class AcceptGateError extends Error {
  constructor(public readonly missing: string[]) {
    super(`accept refused — required frontmatter missing or empty: ${missing.join(", ")}`);
    this.name = "AcceptGateError";
  }
}

/** The stamp-fold verification failure: the note's post-stamp bytes are not the pre-stamp
 * note plus the stamp (something else wrote the note mid-accept, or the stamp did not land).
 * Thrown AFTER the stamp write but BEFORE the baseline advance — fail safe: the baseline is
 * not advanced over content the human did not review. */
export class AcceptFoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcceptFoldError";
  }
}

// The three keys the stamp itself writes — excluded from the fold verification's
// frontmatter comparison (they are EXPECTED to change; a pre-stamp note may also carry
// stale accepted-by/accepted-on from an earlier accepted→revising→proposed round-trip,
// which the stamp legitimately replaces).
const STAMP_KEYS = new Set(["acceptance-status", "accepted-by", "accepted-on"]);

// The sorted non-stamp frontmatter KEY SET of a note — the fold verification's frontmatter
// half. Keys only, not values: processFrontMatter round-trips the whole frontmatter through
// Obsidian's YAML serializer, which may legitimately re-format unrelated VALUES, so a
// value-level comparison would false-abort; a key added or removed by a foreign write is
// the realistic injection shape and survives re-serialization.
function nonStampKeys(content: string): string {
  const { hasFrontmatter, frontmatterText } = parseNote(content);
  if (!hasFrontmatter) return "";
  return [...frontmatterKeys(frontmatterText).keys()]
    .filter((k) => !STAMP_KEYS.has(k))
    .sort()
    .join("\n");
}

/** Local minutes-precision timestamp, `YYYY-MM-DDTHH:mm` — the vault's accepted-on
 * convention. Minutes, not date-only (date-only was a fixed bug — do not regress), and
 * LOCAL time deliberately (it matches what the human at the keyboard sees). */
export function formatLocalMinutes(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ACCEPT — the ONE accept, context-aware across both lifecycles (#221/#164 convergence):
//
//   acceptance-status: proposed  ⇒ conformance-gate check, then STAMP the accepted family
//                                  (via deps.stampAccepted → processFrontMatter), then
//                                  advance the baseline from the POST-stamp content;
//   anything else (no status / revising / already accepted)
//                                ⇒ advance the baseline only — the note is byte-untouched.
//                                  `revising` is deliberately NOT stamped: it goes through
//                                  withdraw / governance_submit_revision back to `proposed`.
//
// ORDERING (the reconcile-correctness invariant): the stamp itself changes the note, so it
// MUST be folded into the accepted snapshot — stamp FIRST, re-read, VERIFY the fold
// (status now accepted, post-stamp BODY byte-identical, non-stamp frontmatter KEY SET
// unchanged), and only then advance the baseline from those post-stamp bytes. The stamp
// therefore can never re-enter the pending queue as a fresh unreviewed change.
// Partial-failure safety falls out of the same order:
//   - gate refusal / stamp throw  ⇒ nothing advanced, nothing logged;
//   - fold verification failure   ⇒ stamp may have landed but NO baseline advance — the
//     baseline never moves over the raced-in content (fail safe);
//   - setBaseline throw after a landed stamp ⇒ baseline unchanged; the note's status is now
//     `accepted`, so a retry Accept takes the advance-only branch and cannot double-stamp.
// There is by construction no state where the baseline advanced but the queue re-shows the
// stamp as pending: any advanced baseline IS the post-stamp bytes.
//
// HONEST LIMIT of the fold verification: it catches a foreign body change and a foreign
// frontmatter key add/remove landing anywhere in the read→stamp→re-read window, but NOT a
// foreign VALUE change to a pre-existing non-stamp key in that same sub-second window —
// processFrontMatter re-serializes every value, so value equality cannot be checked without
// false-aborting legitimate accepts. Such a write is journaled (it went through MCP) but
// would be folded. This narrow residual is the value-level sliver of the same race window
// the pre-convergence accept already had; it is documented in docs/acceptance-model.md.
/** Options for a single accept call. `gateOverride` skips the conformance gate for THIS call
 * only — reachable solely from the pane's gate modal ("Accept anyway"), i.e. a second explicit
 * human gesture after the gate named what is missing. It can never be supplied by an agent:
 * no transport reaches accept at all. */
export interface AcceptOpts { gateOverride?: boolean; }

export async function acceptNote(deps: AcceptDeps, path: string, opts?: AcceptOpts): Promise<AcceptResult> {
  const pre = await deps.readNote(path);
  const status = acceptanceStatusOf(pre);
  let content = pre;
  let stamped = false;

  if (status === "proposed") {
    // Conformance gate — refuse BEFORE any write (no stamp AND no baseline advance), unless
    // the human explicitly overrode it via the pane's gate modal ("Accept anyway" — a second
    // real gesture). The refusal carries the missing keys so the modal can name them.
    if (!opts?.gateOverride) {
      const missing = missingRequiredKeys(pre, deps.requiredFrontmatterKeys);
      if (missing.length > 0) throw new AcceptGateError(missing);
    }

    // STAMP FIRST (see the ordering note above), then fold the stamp into the snapshot.
    await deps.stampAccepted(path, { status: "accepted", by: deps.user, on: deps.nowLocal() });
    const post = await deps.readNote(path);
    if (acceptanceStatusOf(post) !== "accepted") {
      throw new AcceptFoldError(`accept aborted — the stamp did not land on ${path}; baseline NOT advanced`);
    }
    if (parseNote(post).body !== parseNote(pre).body) {
      throw new AcceptFoldError(
        `accept aborted — ${path} changed during the stamp (body differs); baseline NOT advanced — review again`,
      );
    }
    if (nonStampKeys(post) !== nonStampKeys(pre)) {
      throw new AcceptFoldError(
        `accept aborted — ${path} changed during the stamp (frontmatter keys differ); baseline NOT advanced — review again`,
      );
    }
    content = post;
    stamped = true;
  }

  const baseline = await deps.store.setBaseline(path, content, deps.user, deps.now());
  await deps.appendLog({
    action: "accept",
    path,
    ts: deps.now(),
    by: deps.user,
    stamped,
    hash: baseline.hash,
  });
  return { stamped, baseline };
}

// REVERT — restore the note to its accepted baseline and quarantine the rejected current
// version. NEVER deletes: the rejected content is preserved under the quarantine store.
export async function revertNote(deps: AcceptDeps, path: string): Promise<RevertResult> {
  const baseline = deps.store.get(path);
  if (!baseline) throw new Error(`Governance: no baseline to revert to for ${path}`);

  const current = await deps.readNote(path);
  const quarantine = await deps.quarantine(path, current);
  await deps.writeNote(path, baseline.content);

  await deps.appendLog({
    action: "revert",
    path,
    ts: deps.now(),
    by: deps.user,
    quarantine,
  });
  return { quarantine, restoredHash: baseline.hash };
}
