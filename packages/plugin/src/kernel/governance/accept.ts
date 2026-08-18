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

import { stampAcceptance } from "./frontmatter.js";
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

export type LogRecord = StewardshipLogRecord | SilentAdvanceRecord | RevisionDispositionRecord;

// Pure builder for the silent-advance audit record (kept pure so it is headless-testable
// and reused verbatim by wiring.ts's reconcile path).
export function silentAdvanceRecord(args: {
  ts: string;
  path: string;
  reason: SilentAdvanceRecord["reason"];
  fromHash: string | null;
  toHash: string;
}): SilentAdvanceRecord {
  return {
    event: "silent-advance",
    ts: args.ts,
    path: args.path,
    reason: args.reason,
    fromHash: args.fromHash,
    toHash: args.toHash,
  };
}

export interface AcceptDeps {
  readNote(path: string): Promise<string>;
  // Link-safe write of full content (vault.process in production).
  writeNote(path: string, content: string): Promise<void>;
  store: AcceptStore;
  // Move `content` into the quarantine store; returns the quarantine file path. NEVER deletes.
  quarantine(path: string, content: string): Promise<string>;
  appendLog(record: StewardshipLogRecord): Promise<void>;
  now(): string; // ISO timestamp
  user: string;  // accepted-by identity (the human at the keyboard)
}

export interface AcceptResult { stamped: boolean; baseline: Baseline; }
export interface RevertResult { quarantine: string; restoredHash: string; }

// ACCEPT — advance the baseline to current, stamp acceptance-status IF the note carries it,
// and log. This is the one sanctioned place in the whole system that writes `accepted`.
export async function acceptNote(deps: AcceptDeps, path: string): Promise<AcceptResult> {
  let content = await deps.readNote(path);

  const acceptedOn = deps.now().slice(0, 10); // YYYY-MM-DD
  const { content: stampedContent, stamped } = stampAcceptance(content, deps.user, acceptedOn);
  if (stamped) {
    await deps.writeNote(path, stampedContent);
    content = stampedContent;
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
