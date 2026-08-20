// The governance (Acceptance) Obsidian-UI wiring — the module-scope accept path and the
// pane/ribbon/event registration. Ported from obsidian-stewardship/src/main.ts as part of the
// governance module fold (#83, cycle 2). `wireGovernance(plugin, deps)` mounts the pane whenever
// the governance module is enabled — at onload if enabled, AND live the moment a human flips the
// module's enable toggle in settings (main.ts `setGovernanceMounted`), with NO plugin reload. It
// registers everything on a CHILD Component it returns, so an unmount is `plugin.removeChild(it)`.
//
// ============================================================================
//  REACHABILITY — the baseline-advance bug CLASS (read before touching this file)
// ----------------------------------------------------------------------------
//  A capability that advances a baseline, accepts a change, adopts a baseline, or flips an
//  auto-accept class is accept-equivalent: it silences the review queue. The cardinal rule
//  (Assent ch.5) is that NO such capability may be
//    (a) an enumerable method/property reachable by walking from `app` — the plugin instance,
//        its prototype chain, the view/leaf/containerEl, a registered-event handler, or any
//        WeakMap handle — or
//    (b) a registered Obsidian command (vault-mcp ships an ungated `obsidian_run_command`, so a
//        command IS agent-reachable via executeCommandById) — or
//    (c) an MCP tool (the governance module contributes ZERO accept/baseline tools to the
//        transport; obsidian_pending_review, the one MCP read surface, is read-only).
//  Every such capability MUST be a closure captured only by a genuine-user-gesture UI handler,
//  and that handler MUST be wired with `addEventListener('click', …)` — never `el.onclick = …`.
//  An onclick property is itself renderer-reachable: `btn.onclick({isTrusted:true})` forge-calls
//  the handler directly, defeating any isTrusted check that reads a caller-supplied arg.
//  addEventListener listeners are not exposed as a reachable property, so the function cannot be
//  grabbed; and the gate hardens to `isRealGesture` (real Event + isTrusted), which a forged
//  plain object and a synthesized dispatchEvent both fail. See kernel/governance/gesture.ts.
//
//  The accept-equivalent capabilities, and how each is unreachable:
//    - performAccept   — module-scope fn; reached only via the pane Accept button clicks
//                        (gesture-gated; the pending detail view AND the Proposed section —
//                        the SAME context-aware accept). Never a method/field/command/tool.
//    - stampAcceptedFrontmatter — THE ONE PRODUCTION WRITER of the accepted family
//                        (acceptance-status: accepted / accepted-by / accepted-on), via
//                        Obsidian's own app.fileManager.processFrontMatter (#221/#164
//                        convergence). Module-scope, NEVER exported, reached ONLY through
//                        acceptNote's injected stampAccepted dep (buildAcceptDeps), i.e.
//                        only from the gesture-gated performAccept. Never a
//                        method/field/command/tool; the MCP transport cannot reach it —
//                        agent transports still cannot write the accepted family (the
//                        accept-forbidden guard in @vault-mcp/core is untouched; this is
//                        an in-app human-gesture write path that bypasses MCP entirely).
//    - performRevert   — module-scope fn; reached only via the pane Revert button click.
//    - performAdopt    — module-scope fn; reached only via the pane Adopt button (gesture- AND
//                        confirmation-gated). Never a method/field/command/tool.
//    - setClassEnabled — module-scope fn; reached only via the pane allowlist checkbox click
//                        (gesture-gated). Never a method/field/command/tool.
//    - reconcile       — the silent human-edit baseline advance; module-scope fn driven by the
//                        vault "modify" event only. Never a method/field/command/tool.
//  The #101 revision dispositions follow the same shape without being accept-equivalent
//  (they write the agent-legal revising/proposed transitions and advance no baseline, but
//  exercising them confers human standing, so they stay gesture-only):
//    - performRequestChanges — module-scope fn; reached only via the pane's Request-changes
//                        button + gesture-gated modal confirm. Never a method/command/tool.
//    - performWithdraw — module-scope fn; reached only via the Revising section's Withdraw
//                        button (gesture-gated). Never a method/command/tool.
//  The BaselineStore (its setBaseline is the raw advance primitive) lives in a module-private
//  WeakMap keyed by the plugin instance — never `this.store`. getStore is a module-scope fn.
//  The controller handed to the view carries the accept callables and lives in the view's own
//  module-private WeakMap (pane.ts `viewDeps`), never on any instance. The plugin registers ZERO
//  governance commands.
// ============================================================================

import type { AcceptOpts } from "../kernel/governance/accept.js";
import { Component, TFile, TFolder, MarkdownView, Notice, type WorkspaceLeaf, type Plugin, type DataAdapter } from "obsidian";
import { BaselineStore, type BlobFs } from "../kernel/governance/baseline-store.js";
import { parseJournal, recentAgentWrite, agentWritesSince, type JournalRecord } from "../kernel/governance/journal-reader.js";
import { computeQueue, type PendingItem, type NoteSnapshot } from "../kernel/governance/queue.js";
import { deleteInvalidatesQueue } from "./queue-invalidation.js";
import { classifyModify, shouldAdvanceBaselineSilently } from "../kernel/governance/classify.js";
import {
  acceptNote,
  revertNote,
  silentAdvanceRecord,
  formatLocalMinutes,
  type AcceptDeps,
  type AcceptResult,
  type AcceptanceStampFields,
  type LogRecord,
} from "../kernel/governance/accept.js";
import { buildProposedList, type ProposedItem } from "../kernel/governance/proposed.js";
import { insertRevisionRequest, withdrawRevisionRequests } from "../kernel/governance/revision.js";
import { contentHash } from "../kernel/governance/hash.js";
import {
  AUTHORIZED_CLASSES,
  DEFAULT_ALLOWLIST,
  normalizeAllowlist,
  serializeAllowlist,
  deserializeAllowlist,
  type ClassId,
} from "../kernel/governance/auto-accept/classes.js";
import { evaluate, autoAcceptRecord, type AutoAcceptRecord } from "../kernel/governance/auto-accept/eligibility.js";
import { serializePendingIndex } from "../kernel/governance/pending-index.js";
import {
  pruneRenameRecords,
  serializeRenameRecords,
  deserializeRenameRecords,
  RENAME_RECORDS_CAP,
  RENAME_RECORD_TTL_MS,
  type RenameRecordData,
} from "../kernel/governance/rename-records.js";
import { autoAcceptPolicyOf, protectedPropertyDrift, type AutoAcceptPolicy } from "../kernel/governance/protected-policy.js";
import type { RenameIndex } from "../kernel/governance/auto-accept/detectors.js";
import { badgeVisible } from "../kernel/governance/badge.js";
import { governanceDisplaySettings, governanceAcceptanceSettings } from "../kernel/governance/settings.js";
import { isRealGesture } from "../kernel/governance/gesture.js";
import { computeAcceptEligiblePaths } from "../kernel/governance/menu-eligibility.js";
import {
  GovernanceReviewView,
  VIEW_TYPE_GOVERNANCE,
  confirmAdopt,
  renderAllowlist,
  wireAdoptButton,
  ADOPT_BASELINE_DESC,
  acceptThroughGate,
  type ReviewController,
  type RevisingItem,
} from "./pane.js";

// Top-level areas the plugin must never review or touch (guarded territories / hold zones — they
// are archival, not live governed content).
const EXCLUDED_PREFIXES = ["obsidian-old/", "80-89", "_keep/", "holds/"];

const LOCAL_USER = "local-human";
const RECENT_WRITE_WINDOW_MS = 15_000;
const SILENT_ADVANCE_DEBOUNCE_MS = 1200;
const HUMAN_INPUT_WINDOW_MS = 5_000;
const JOURNAL_POLL_MS = 2500;
/** Coalesce a burst of deletes (a folder of pending notes) into ONE queue recompute. Short enough
 *  that the row disappears as the user watches, long enough to absorb a multi-file delete. */
const QUEUE_DELETE_DEBOUNCE_MS = 300;
/** Reserved key in the shared per-plugin timer map (timersFor) — that map is otherwise keyed by
 *  note path, and the teardown hook clears every timer in it, this one included. */
const QUEUE_DELETE_TIMER = "\u0000queue-delete";

/** What wireGovernance needs from the host plugin beyond the base Plugin surface: a reader for
 * the acceptance module's config (`settings.modules.acceptance.config`), from which the badge
 * display prefs are derived. Plain data — confers no accept capability. */
export interface GovernanceWireDeps {
  getConfig: () => Record<string, unknown>;
}

// ── module-private per-plugin state (WeakMaps, keyed by the plugin instance) ──
// None of this is reachable by walking `app`: the WeakMap bindings are module-local and their
// entries are not enumerable.

const baselineStores = new WeakMap<Plugin, BaselineStore>();
function getStore(plugin: Plugin): BaselineStore {
  const s = baselineStores.get(plugin);
  if (!s) throw new Error("governor acceptance: baseline store not initialised");
  return s;
}

// Whether governance is CURRENTLY mounted for this plugin (the accept path is live). Added on a
// successful wireGovernance, deleted on the mount's Component teardown — so it is a definitive
// "is the accept path live" signal, unlike `baselineStores` (whose entry survives an unmount as a
// stale store). The settings-tab render (renderGovernanceSettings) reads it to decide between the
// gesture-gated controls and a short "enable governance" hint. Module-private, never reachable
// from `app`, and it holds no callable — a plain membership flag.
const mountedPlugins = new WeakSet<Plugin>();
export function isGovernanceMounted(plugin: Plugin): boolean {
  return mountedPlugins.has(plugin);
}

interface PluginPaths {
  baseDir: string;
  quarantineDir: string;
  logPath: string;
  journalDir: string;
  allowlistPath: string;
  /** Where refresh() PUBLISHES the pending-review index (#261) — the file
   * obsidian_pending_review reads. Beside the acceptance log; vault-mcp-owned. */
  pendingIndexPath: string;
  /** Durable rename captures for the link-heal oracle (#261). */
  renameRecordsPath: string;
}
const pluginPaths = new WeakMap<Plugin, PluginPaths>();
function paths(plugin: Plugin): PluginPaths {
  const p = pluginPaths.get(plugin);
  if (!p) throw new Error("governor acceptance: paths not initialised");
  return p;
}

const configReaders = new WeakMap<Plugin, () => Record<string, unknown>>();
function displaySettings(plugin: Plugin) {
  return governanceDisplaySettings(configReaders.get(plugin)?.() ?? {});
}
// The acceptance-convergence config (#221/#164): the accepted-by identity + the optional
// required-frontmatter conformance gate. Read live per accept, like the badge prefs. Plain
// data — human-only-mutable (the settings tab is not agent-reachable) and confers no accept
// capability (`requiredFrontmatterKeys` can only make Accept refuse MORE, never accept more).
function acceptanceSettings(plugin: Plugin) {
  return governanceAcceptanceSettings(configReaders.get(plugin)?.() ?? {});
}

const cachedPending = new WeakMap<Plugin, PendingItem[]>();
/** Monotonic per-plugin refresh generation — see the guard at the top of refresh(). */
const refreshGen = new WeakMap<Plugin, number>();
function getCachedPending(plugin: Plugin): PendingItem[] {
  return cachedPending.get(plugin) ?? [];
}

interface PollState { lastSig: string; inFlight: boolean; }
const pollStates = new WeakMap<Plugin, PollState>();
function pollState(plugin: Plugin): PollState {
  let s = pollStates.get(plugin);
  if (!s) { s = { lastSig: "", inFlight: false }; pollStates.set(plugin, s); }
  return s;
}

const ribbonEls = new WeakMap<Plugin, HTMLElement>();
const badgeEls = new WeakMap<Plugin, HTMLElement>();

const silentTimers = new WeakMap<Plugin, Map<string, ReturnType<typeof setTimeout>>>();
function timersFor(plugin: Plugin): Map<string, ReturnType<typeof setTimeout>> {
  let m = silentTimers.get(plugin);
  if (!m) { m = new Map(); silentTimers.set(plugin, m); }
  return m;
}

// Per-plugin record of the last GENUINE human input event (isTrusted beforeinput/paste on the
// editor) per note path, in epoch-ms. The POSITIVE human-authorship signal that gates the silent
// baseline advance (see classify.ts). Module-private, never a reachable field. Confers no accept
// capability: plain timestamps, read only by reconcile to DECIDE (never force) a classification;
// a forged entry cannot advance a baseline without a real content change already matching.
const humanInputAt = new WeakMap<Plugin, Map<string, number>>();
function humanInputMap(plugin: Plugin): Map<string, number> {
  let m = humanInputAt.get(plugin);
  if (!m) { m = new Map(); humanInputAt.set(plugin, m); }
  return m;
}
function recordHumanInput(plugin: Plugin): void {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  const path = view?.file?.path;
  if (!path) return;
  humanInputMap(plugin).set(path, Date.now());
}
function recentGenuineHumanInput(plugin: Plugin, path: string, nowMs: number, windowMs: number): boolean {
  const at = humanInputMap(plugin).get(path);
  return at !== undefined && nowMs - at <= windowMs && nowMs - at >= 0;
}

// ── AUTO-ACCEPT allowlist (HUMAN-ONLY-MUTABLE) ───────────────────────────────
// Everything here is module-scope. The only mutator (setClassEnabled) refuses unless handed a
// genuine trusted gesture and is reached ONLY from the pane's allowlist-checkbox click handler —
// never walkable from `app`. The universe of ever-allowable classes is the frozen
// AUTHORIZED_CLASSES: a tampered allowlist file can at most enable/disable AMONG those four
// rail-neutral classes, never introduce a new one (that requires a reviewed code change).
const allowlists = new WeakMap<Plugin, Set<ClassId>>();
function allowlistFor(plugin: Plugin): Set<ClassId> {
  let s = allowlists.get(plugin);
  if (!s) { s = new Set(DEFAULT_ALLOWLIST); allowlists.set(plugin, s); }
  return s;
}
function getEnabledClasses(plugin: Plugin): ClassId[] {
  return normalizeAllowlist([...allowlistFor(plugin)]);
}
function isClassEnabled(plugin: Plugin, cls: ClassId): boolean {
  return allowlistFor(plugin).has(cls);
}
async function loadAllowlist(plugin: Plugin): Promise<void> {
  let ids: ClassId[];
  try {
    const p = paths(plugin).allowlistPath;
    if (await plugin.app.vault.adapter.exists(p)) {
      ids = deserializeAllowlist(await plugin.app.vault.adapter.read(p));
    } else {
      ids = [...DEFAULT_ALLOWLIST];
    }
  } catch {
    ids = [...DEFAULT_ALLOWLIST];
  }
  allowlists.set(plugin, new Set(ids));
}
async function saveAllowlist(plugin: Plugin): Promise<void> {
  try {
    await plugin.app.vault.adapter.write(paths(plugin).allowlistPath, serializeAllowlist(getEnabledClasses(plugin)));
  } catch (e) {
    console.error("governor acceptance: failed to persist auto-accept allowlist", e);
  }
}
// The ONLY allowlist mutator. Accept-equivalent authority, so it is gesture-gated exactly like
// adopt-baseline: it does nothing unless `evt` is a genuine trusted gesture. A forged plain
// object or a synthesized (untrusted) event → refused (returns false), allowlist unchanged.
async function setClassEnabled(plugin: Plugin, cls: ClassId, on: boolean, evt: unknown): Promise<boolean> {
  if (!isRealGesture(evt)) return false;
  const set = allowlistFor(plugin);
  if (on) set.add(cls); else set.delete(cls);
  await saveAllowlist(plugin);
  return true;
}

// ── rename index (link-heal's confirmation oracle) ───────────────────────────
// PERSISTED across reloads since #261 (governance/rename-records.json). Obsidian's own
// link-updating rename rewrites wikilinks in other notes; when those rewrites reach review
// AFTER a plugin reload, an in-memory-only oracle could no longer confirm them, so the
// rewritten notes wedged pending forever (the live #261 repro). Records are plain data,
// TTL'd + capped by the pure kernel module; losing them only makes MORE stay pending.
interface RenameRecord { oldTargets: Set<string>; newTargets: Set<string>; at: number; }
const renameRecords = new WeakMap<Plugin, RenameRecord[]>();
function renameRecordsFor(plugin: Plugin): RenameRecord[] {
  let r = renameRecords.get(plugin);
  if (!r) { r = []; renameRecords.set(plugin, r); }
  return r;
}
function linkTargetsOf(path: string): Set<string> {
  const noExt = path.replace(/\.md$/i, "");
  const base = noExt.split("/").pop() ?? noExt;
  return new Set([base, noExt, path]);
}
function recordRename(plugin: Plugin, newPath: string, oldPath: string): void {
  if (!newPath.toLowerCase().endsWith(".md")) return;
  renameRecordsFor(plugin).push({
    oldTargets: linkTargetsOf(oldPath),
    newTargets: linkTargetsOf(newPath),
    at: Date.now(),
  });
  pruneLiveRenameRecords(plugin, Date.now());
  void persistRenameRecords(plugin);
}
// TTL/cap must bind the LIVE list the oracle consults, not just the persisted file — otherwise
// a month-old record still confirms in a long-running session (review finding on #261).
function pruneLiveRenameRecords(plugin: Plugin, nowMs: number): void {
  const live = renameRecordsFor(plugin);
  const kept = live.filter((r) => nowMs - r.at <= RENAME_RECORD_TTL_MS && nowMs - r.at >= 0);
  const capped = kept.length > RENAME_RECORDS_CAP ? kept.slice(kept.length - RENAME_RECORDS_CAP) : kept;
  if (capped.length !== live.length) renameRecords.set(plugin, capped);
}
async function loadRenameRecords(plugin: Plugin): Promise<void> {
  let data: RenameRecordData[] = [];
  try {
    const p = paths(plugin).renameRecordsPath;
    if (await plugin.app.vault.adapter.exists(p)) {
      data = pruneRenameRecords(deserializeRenameRecords(await plugin.app.vault.adapter.read(p)), Date.now());
    }
  } catch (e) {
    console.error("governor acceptance: failed to load rename records", e);
    data = [];
  }
  renameRecords.set(
    plugin,
    data.map((r) => ({ oldTargets: new Set(r.old), newTargets: new Set(r.new), at: r.at })),
  );
}
// Persist writes are CHAINED per plugin (the WriteJournal.append pattern): a batch move fires
// many rename events back-to-back, and unserialized concurrent adapter.writes to one file can
// land out of order — a smaller, earlier snapshot finishing last would silently truncate the
// records the persistence exists to keep (review finding on #261).
const renamePersistTails = new WeakMap<Plugin, Promise<void>>();
async function persistRenameRecords(plugin: Plugin): Promise<void> {
  const tail = renamePersistTails.get(plugin) ?? Promise.resolve();
  const next = tail.then(async () => {
    try {
      const pruned = pruneRenameRecords(
        renameRecordsFor(plugin).map((r) => ({ old: [...r.oldTargets], new: [...r.newTargets], at: r.at })),
        Date.now(),
      );
      await plugin.app.vault.adapter.write(paths(plugin).renameRecordsPath, serializeRenameRecords(pruned));
    } catch (e) {
      console.error("governor acceptance: failed to persist rename records", e);
    }
  });
  renamePersistTails.set(plugin, next);
  await next;
}
class VaultRenameIndex implements RenameIndex {
  constructor(private readonly plugin: Plugin) {}
  confirms(fromTarget: string, toTarget: string): boolean {
    const from = fromTarget.trim();
    const to = toTarget.trim();
    if (!from || !to || from === to) return false;
    for (const rec of renameRecordsFor(this.plugin)) {
      if (rec.oldTargets.has(from) && rec.newTargets.has(to)) return true;
    }
    return false;
  }
}
const renameIndexes = new WeakMap<Plugin, VaultRenameIndex>();
function getRenameIndex(plugin: Plugin): VaultRenameIndex {
  let idx = renameIndexes.get(plugin);
  if (!idx) { idx = new VaultRenameIndex(plugin); renameIndexes.set(plugin, idx); }
  return idx;
}

// ── module-scope IO helpers (app.vault-equivalent; NOT instance methods) ──────
function readNote(plugin: Plugin, path: string): Promise<string> {
  const file = plugin.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return Promise.reject(new Error(`not a note: ${path}`));
  return plugin.app.vault.read(file);
}
async function writeNote(plugin: Plugin, path: string, content: string): Promise<void> {
  const file = plugin.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error(`not a note: ${path}`);
  await plugin.app.vault.process(file, () => content);
}
async function quarantineWrite(plugin: Plugin, path: string, content: string): Promise<string> {
  const dir = paths(plugin).quarantineDir;
  if (!(await plugin.app.vault.adapter.exists(dir))) {
    await plugin.app.vault.adapter.mkdir(dir);
  }
  const safe = path.replace(/[\/\\]/g, "__");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const qPath = `${dir}/${safe}-${ts}.md`;
  await plugin.app.vault.adapter.write(qPath, content);
  return qPath;
}
// Off the instance so an attacker cannot forge plugin-authored-looking log records via
// `plugin.appendLog(...)`. (They can still write the file directly via app.vault.adapter — but
// that is not a governance-blessed logger; we simply don't hand them one.)
async function appendLog(plugin: Plugin, record: LogRecord | AutoAcceptRecord): Promise<void> {
  await plugin.app.vault.adapter.append(paths(plugin).logPath, JSON.stringify(record) + "\n");
}
// Read the acceptance log for the DISPLAY-ONLY history browser. Read-only by construction:
// nothing derived from it feeds a baseline advance, and the pane renders it via text nodes only.
// An ABSENT log is genuinely empty history (""), but a read FAILURE returns null so the pane can
// say "history unavailable" — an unreadable audit log must never render as a clean empty one.
async function readAcceptanceLog(plugin: Plugin): Promise<string | null> {
  try {
    const p = paths(plugin).logPath;
    if (!(await plugin.app.vault.adapter.exists(p))) return "";
    return await plugin.app.vault.adapter.read(p);
  } catch {
    return null;
  }
}
async function readJournal(plugin: Plugin): Promise<JournalRecord[]> {
  const adapter = plugin.app.vault.adapter;
  const dir = paths(plugin).journalDir;
  if (!(await adapter.exists(dir))) return [];
  const listing = await adapter.list(dir);
  const records: JournalRecord[] = [];
  for (const f of listing.files) {
    if (!f.endsWith(".jsonl")) continue;
    try { records.push(...parseJournal(await adapter.read(f))); } catch { /* skip */ }
  }
  return records;
}
// A cheap change-signature over the vault-mcp write journal (size+mtime per .jsonl file). The
// pending queue is derived from this journal, so when the signature changes an agent write has
// landed and the queue must be recomputed. Reads no note content, only stats. Advances no baseline.
async function journalSignature(plugin: Plugin): Promise<string> {
  const adapter = plugin.app.vault.adapter;
  const dir = paths(plugin).journalDir;
  if (!(await adapter.exists(dir))) return "";
  const listing = await adapter.list(dir);
  const parts: string[] = [];
  for (const f of listing.files.slice().sort()) {
    if (!f.endsWith(".jsonl")) continue;
    const st = await adapter.stat(f);
    if (st) parts.push(`${f}:${st.size}:${st.mtime}`);
  }
  return parts.join("|");
}

// ── governed-note enumeration (module-scope helpers) ─────────────────────────
function isExcluded(path: string): boolean {
  return EXCLUDED_PREFIXES.some((p) => path.startsWith(p));
}
function governedMarkdownFiles(plugin: Plugin): TFile[] {
  return plugin.app.vault.getMarkdownFiles().filter((f) => !isExcluded(f.path));
}

// ── accept / revert / adopt — module-scope, closure-captured only by UI handlers ──
//
// THE ONE PRODUCTION WRITER of the accepted family (#221/#164 acceptance convergence).
// Writes acceptance-status: accepted + accepted-by + accepted-on into the note's frontmatter
// via Obsidian's own app.fileManager.processFrontMatter — an in-app write that never touches
// the MCP transport (the accept-forbidden guard on every agent transport is untouched and
// still refuses the accepted family; this path is what the guard reserves for the human).
// Module-scope, NEVER exported, never a command/method/tool: it is reachable ONLY through
// acceptNote's injected `stampAccepted` dep below, i.e. only from the gesture-gated
// performAccept. `fields.status` is the literal type "accepted" (AcceptanceStampFields), so
// this writer structurally cannot stamp any other value.
async function stampAcceptedFrontmatter(plugin: Plugin, path: string, fields: AcceptanceStampFields): Promise<void> {
  const file = noteFileOf(plugin, path);
  await plugin.app.fileManager.processFrontMatter(file, (fm) => {
    fm["acceptance-status"] = fields.status;
    fm["accepted-by"] = fields.by;
    fm["accepted-on"] = fields.on;
  });
}
function buildAcceptDeps(plugin: Plugin): AcceptDeps {
  const acceptance = acceptanceSettings(plugin);
  return {
    readNote: (p) => readNote(plugin, p),
    writeNote: (p, c) => writeNote(plugin, p, c),
    stampAccepted: (p, fields) => stampAcceptedFrontmatter(plugin, p, fields),
    store: {
      get: (p) => getStore(plugin).get(p),
      setBaseline: (p, c, by, at) => getStore(plugin).setBaseline(p, c, by, at),
    },
    quarantine: (p, c) => quarantineWrite(plugin, p, c),
    appendLog: (r) => appendLog(plugin, r),
    now: () => new Date().toISOString(),
    nowLocal: () => formatLocalMinutes(new Date()),
    user: acceptance.acceptedBy,
    requiredFrontmatterKeys: acceptance.gateMode === "off" ? [] : acceptance.requiredFrontmatterKeys,
  };
}
// The ONE context-aware accept (both the pending detail view's Accept and the Proposed
// section's Accept land here). acceptNote stamps FIRST (proposed notes only) and advances
// the baseline from the post-stamp content, so the stamp never re-queues; see accept.ts.
async function performAccept(plugin: Plugin, path: string, opts?: AcceptOpts): Promise<AcceptResult> {
  // #228 race discipline, extended to the converged accept: the stamp is a PROGRAMMATIC
  // write, but the human just clicked (and may have typed in this note's editor moments
  // before). A lingering genuine-human-input record for this path would let the debounced
  // reconcile misattribute programmatic/agent content as a human edit and silently
  // baseline-advance it. Clear the record on BOTH sides of the write: at entry, so a
  // pre-click typing record cannot ride a reconcile that fires MID-accept (a slow stamp +
  // re-read can outlast the 1200ms debounce), and in `finally`, because a partially-failed
  // accept (stamp landed, baseline advance threw) has still written.
  humanInputMap(plugin).delete(path);
  try {
    return await acceptNote(buildAcceptDeps(plugin), path, opts);
  } finally {
    humanInputMap(plugin).delete(path);
    await refresh(plugin);
  }
}
async function performRevert(plugin: Plugin, path: string): Promise<void> {
  await revertNote(buildAcceptDeps(plugin), path);
  await refresh(plugin);
}
// Adopt current state as baseline — snapshots EVERY governed note as the accepted baseline and
// clears the queue. The most dangerous capability (mass-silence), reached ONLY through a
// gesture-gated + confirmation-gated pane button. Neither a command nor a method/field/tool.
async function performAdopt(plugin: Plugin): Promise<number> {
  const files = governedMarkdownFiles(plugin);
  let n = 0;
  const at = new Date().toISOString();
  for (const file of files) {
    const content = await plugin.app.vault.cachedRead(file);
    await getStore(plugin).setBaseline(file.path, content, "baseline-adopt", at);
    n++;
  }
  await refresh(plugin);
  return n;
}

// ── revision round-trip (#101) — module-scope, closure-captured only by UI handlers ──
// The two NEW human dispositions. NOT accept-equivalent — `revising` and `proposed` are
// agent-legal acceptance-status transitions (only the accepted-family is forbidden) and no
// baseline moves — but exercising them from the pane confers human standing ("a human asked
// for changes"), so they keep the performAdopt perimeter: module-scope functions, reached only
// from gesture-gated pane handlers, never a command / instance method / MCP tool.
function noteFileOf(plugin: Plugin, path: string): TFile {
  const file = plugin.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error(`not a note: ${path}`);
  return file;
}
// request-changes: insert the reviewer's text as a `[!revision-request]` callout directly below
// the note's H1 (top of body when there is no H1 — kernel/governance/revision.ts, bound to the
// shared core frontmatter recognizer), then set acceptance-status: revising via Obsidian's own
// processFrontMatter. Status stays frontmatter (the Bases queue needs it); the FEEDBACK lives in
// the note body — there is deliberately NO `requested-changes` property (2026-08-17 amendment).
async function performRequestChanges(plugin: Plugin, path: string, text: string): Promise<void> {
  const file = noteFileOf(plugin, path);
  const nowIso = new Date().toISOString();
  await plugin.app.vault.process(file, (data) => insertRevisionRequest(data, text, nowIso.slice(0, 10)));
  await plugin.app.fileManager.processFrontMatter(file, (fm) => {
    fm["acceptance-status"] = "revising";
  });
  // These writes are PROGRAMMATIC, but the human just TYPED (in the modal). If the reviewed note
  // is also the active editor tab, that typing recorded a genuine-human-input timestamp for this
  // path — and the debounced reconcile would then misread our write as a human edit and SILENTLY
  // BASELINE-ADVANCE the agent's unreviewed content without an Accept. Clear the record so the
  // reconcile classifies these modify events as ambiguous (fail safe: no advance, stays pending).
  humanInputMap(plugin).delete(path);
  await appendLog(plugin, { action: "request-changes", path, ts: nowIso, by: LOCAL_USER });
  await refresh(plugin);
}
// withdraw: remove the `[!revision-request]` callout(s) this flow inserted — nothing else in the
// body — and set acceptance-status back to proposed.
async function performWithdraw(plugin: Plugin, path: string): Promise<void> {
  const file = noteFileOf(plugin, path);
  const nowIso = new Date().toISOString();
  await plugin.app.vault.process(file, (data) => withdrawRevisionRequests(data).content);
  await plugin.app.fileManager.processFrontMatter(file, (fm) => {
    fm["acceptance-status"] = "proposed";
  });
  // Same misattribution guard as performRequestChanges: our programmatic writes must not ride a
  // recent genuine-human-input record into a silent baseline advance.
  humanInputMap(plugin).delete(path);
  await appendLog(plugin, { action: "withdraw-request", path, ts: nowIso, by: LOCAL_USER });
  await refresh(plugin);
}
// The Revising listing — read-only, from Obsidian's metadata cache (no file reads). Plain data.
// Sorted by mtime DESCENDING (most recently touched first) — the same "newest activity
// first" convention as the pending queue and the Proposed listing below. `RevisingItem`
// itself carries no mtime (display data only); decorate-sort-undecorate keeps that public
// shape unchanged.
function listRevising(plugin: Plugin): RevisingItem[] {
  const out: Array<RevisingItem & { mtime: number }> = [];
  for (const file of governedMarkdownFiles(plugin)) {
    const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
    if (fm?.["acceptance-status"] === "revising") {
      out.push({ path: file.path, title: file.basename, mtime: file.stat.mtime });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).map(({ path, title }) => ({ path, title }));
}
// The Proposed listing (#221/#164) — read-only, from the metadata cache exactly like the
// Revising listing, with the dedupe/exclusion rules in the pure kernel builder: proposed
// notes ALREADY in the pending queue are deduped out (their queue row carries the same
// context-aware Accept), and the EXCLUDED_PREFIXES territories are respected. Plain data.
function listProposed(plugin: Plugin): ProposedItem[] {
  const candidates = plugin.app.vault.getMarkdownFiles().map((file) => ({
    path: file.path,
    title: file.basename,
    status: (plugin.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined)?.[
      "acceptance-status"
    ],
    mtime: file.stat.mtime,
  }));
  return buildProposedList(candidates, getCachedPending(plugin).map((p) => p.path), isExcluded);
}
// The metadata-cache acceptance-status of ONE note — plain display data for the pane's
// context-aware Accept surfacing (button tooltip + Notice). Read-only; confers nothing.
function acceptanceStatusFor(plugin: Plugin, path: string): string | null {
  const file = plugin.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return null;
  const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
  const v = fm?.["acceptance-status"];
  return typeof v === "string" ? v : null;
}

// The controller handed to the view. Carries accept/revert/adopt/setClassEnabled callables —
// passed straight into the view constructor (which stows it in a module-private WeakMap) and never
// stored on the plugin. Built fresh per view instantiation.
function buildController(plugin: Plugin): ReviewController {
  return {
    getPending: () => getCachedPending(plugin),
    getBaselineContent: (path) => getStore(plugin).get(path)?.content ?? null,
    readCurrent: (path) => readNote(plugin, path),
    accept: (path, opts) => performAccept(plugin, path, opts),
    gateMode: () => acceptanceSettings(plugin).gateMode,
    revert: (path) => performRevert(plugin, path),
    adopt: async () => { await performAdopt(plugin); },
    refresh: () => refresh(plugin),
    showTabBadge: () => displaySettings(plugin).showViewTabBadge,
    authorizedClasses: () => AUTHORIZED_CLASSES,
    isClassEnabled: (id) => isClassEnabled(plugin, id),
    setClassEnabled: (id, on, evt) => setClassEnabled(plugin, id, on, evt),
    // History browser: read-only log text (display-only in the pane; text nodes only).
    readAcceptanceLog: () => readAcceptanceLog(plugin),
    // Revision round-trip (#101): the two human dispositions + the read-only revising listing.
    requestChanges: (path, text) => performRequestChanges(plugin, path, text),
    withdraw: (path) => performWithdraw(plugin, path),
    getRevising: () => listRevising(plugin),
    // Acceptance convergence (#221/#164): the Proposed listing + the plain display data the
    // pane uses to SURFACE what the context-aware Accept will do (identity + per-note status).
    getProposed: () => listProposed(plugin),
    acceptedBy: () => acceptanceSettings(plugin).acceptedBy,
    acceptanceStatus: (path) => acceptanceStatusFor(plugin, path),
    // #135/#224 read-only display data: the HONORED per-note auto-accept policy
    // (from the blessed baseline — never the raw frontmatter). Confers nothing;
    // the pane only badges it.
    honoredAutoAccept: (path) => autoAcceptPolicyOf(getStore(plugin).get(path)?.content ?? null),
  };
}

// ── silent human-edit baseline advance (module-scope; driven by the vault modify event) ──
function scheduleReconcile(plugin: Plugin, file: TFile): void {
  const path = file.path;
  if (isExcluded(path)) return;
  const timers = timersFor(plugin);
  const existing = timers.get(path);
  if (existing) clearTimeout(existing);
  timers.set(path, setTimeout(() => {
    void reconcile(plugin, file).catch((e) => console.error(`governor acceptance: reconcile failed for ${path}`, e));
  }, SILENT_ADVANCE_DEBOUNCE_MS));
}
async function reconcile(plugin: Plugin, file: TFile): Promise<void> {
  timersFor(plugin).delete(file.path);
  const path = file.path;
  const baseline = getStore(plugin).get(path);
  let current: string;
  try { current = await plugin.app.vault.read(file); } catch { return; }

  // Our own accept/revert writes land the note exactly on its (new) baseline — skip them.
  if (baseline && contentHash(current) === baseline.hash) { await refresh(plugin); return; }

  const journal = await readJournal(plugin);
  const nowIso = new Date().toISOString();
  // POSITIVE human-authorship signal: a genuine (isTrusted) input event on THIS path within the
  // window. Mere active-editor focus is NOT used — a non-journaled/programmatic write to the
  // focused file must NOT be misread as human.
  const cls = classifyModify({
    recentAgentWrite: recentAgentWrite(journal, path, nowIso, RECENT_WRITE_WINDOW_MS),
    recentGenuineHumanInput: recentGenuineHumanInput(plugin, path, Date.now(), HUMAN_INPUT_WINDOW_MS),
  });

  if (shouldAdvanceBaselineSilently(cls)) {
    // Human-attributed change → advance the baseline silently (it must never queue). Log it (D2 —
    // audit completeness). NOT app-reachable: invoked only by the debounced vault "modify" event.
    const toHash = contentHash(current);
    await getStore(plugin).setBaseline(path, current, "human-silent", nowIso);
    await appendLog(plugin, silentAdvanceRecord({
      ts: nowIso,
      path,
      reason: "human-edit",
      fromHash: baseline ? baseline.hash : null,
      toHash,
    }));
  } else if (cls === "agent") {
    // "agent": try the ONE automated exception — auto-accept, iff the change is provably a
    // mechanical, allowlisted, rail-neutral class. Conservative + fail-safe.
    await maybeAutoAccept(plugin, path);
  }
  await refresh(plugin);
}

// ── AUTO-ACCEPT: the eligibility+advance step (module-scope; event-driven, never a method) ──
// Evaluate a pending, agent-attributed change; if it is EXACTLY one-or-more allowlisted mechanical
// classes with no residual and rail-clean, advance the baseline via the SAME primitive manual
// Accept uses (getStore().setBaseline) and write a LOUD audit record. Returns whether it accepted.
// FAIL-SAFE: no baseline, no change, not agent-attributed, not eligible, or ANY exception → false.
// Reads NO agent-supplied field — eligibility is bytes + rename index.
async function maybeAutoAccept(plugin: Plugin, path: string): Promise<boolean> {
  try {
    if (isExcluded(path)) return false;
    const store = getStore(plugin);
    const baseline = store.get(path);
    if (!baseline) return false;
    let current: string;
    try { current = await readNote(plugin, path); } catch { return false; }
    const fromHash = baseline.hash;
    const toHash = contentHash(current);
    if (toHash === fromHash) return false;

    // OBJECTIVE agent-attribution: a pending change requires an agent (MCP) content write since
    // the baseline. We use only the COUNT — never `intent` or any other agent-supplied field.
    const journal = await readJournal(plugin);
    if (agentWritesSince(journal, path, baseline.acceptedAt).length === 0) return false;

    // The per-note policy (#135) is the HONORED one — derived from the blessed
    // BASELINE frontmatter, never the raw current note (honor-only-if-blessed,
    // #224). A side-door `auto-accept` sitting only in the current bytes
    // therefore confers nothing here.
    const policy = autoAcceptPolicyOf(baseline.content);
    const result = evaluate(baseline.content, current, {
      enabled: getEnabledClasses(plugin),
      renameIndex: getRenameIndex(plugin),
      policy,
    });
    if (!result.eligible) {
      // #261 visibility: when the HUMAN delegated (an honored per-note policy exists) and the
      // machine still declines, that is the surprising case — say WHY, once per content-state
      // (fromHash:toHash:reason), so a wedged note is diagnosable from the console instead of
      // silently pending forever. Class-only refusals stay quiet (every ordinary agent edit
      // is "not eligible" by design — logging those would be noise).
      if (policy) logRefusalOnce(plugin, path, `${fromHash}:${toHash}:${result.reason}`, policy, result.reason);
      return false;
    }

    const nowIso = new Date().toISOString();
    await store.setBaseline(path, current, "auto-accept", nowIso);
    await appendLog(plugin, autoAcceptRecord({
      ts: nowIso,
      path,
      fromHash,
      toHash,
      classes: result.classes,
      railResult: result.rail,
      // Audit which policy drove a policy-accept (#135) — like class accepts log their classes.
      policy: result.policy,
    }));
    return true;
  } catch (e) {
    // Fail safe — never let an exception advance a baseline. But NEVER silently (#261):
    // a swallowed throw here made the whole sweep undiagnosable from outside.
    console.error(`governor acceptance: auto-accept check failed for ${path}`, e);
    return false;
  }
}

// One console.warn per (path → content-state) policy refusal — see maybeAutoAccept.
const refusalLogState = new WeakMap<Plugin, Map<string, string>>();
function logRefusalOnce(plugin: Plugin, path: string, key: string, policy: AutoAcceptPolicy, reason: string): void {
  let m = refusalLogState.get(plugin);
  if (!m) { m = new Map(); refusalLogState.set(plugin, m); }
  if (m.get(path) === key) return;
  m.set(path, key);
  console.warn(`governor acceptance: auto-accept (policy: ${policy}) declined for ${path}: ${reason}`);
}
// Sweep the (agent-attributed) pending queue for auto-accept-eligible changes. Driven by the
// journal-growth poll — the interval timer plus, since #261, the kernel's post-append nudge
// (nudgeGovernanceQueue below; still not agent-reachable as a callable — an agent can only
// influence WHEN it runs by writing, which the interval already allowed).
async function sweepAutoAccept(plugin: Plugin): Promise<number> {
  let n = 0;
  for (const item of getCachedPending(plugin)) {
    if (await maybeAutoAccept(plugin, item.path)) n++;
  }
  return n;
}

// A DataAdapter-backed BlobFs for the baseline store.
class AdapterBlobFs implements BlobFs {
  constructor(private readonly adapter: DataAdapter) {}
  read(path: string): Promise<string> { return this.adapter.read(path); }
  write(path: string, data: string): Promise<void> { return this.adapter.write(path, data); }
  exists(path: string): Promise<boolean> { return this.adapter.exists(path); }
  async mkdir(path: string): Promise<void> { await this.adapter.mkdir(path); }
  async list(dir: string): Promise<string[]> {
    if (!(await this.adapter.exists(dir))) return [];
    const listing = await this.adapter.list(dir);
    return listing.files;
  }
}

// ── queue / badge refresh (read-only: recomputes the queue; advances no baseline) ──
async function refresh(plugin: Plugin): Promise<void> {
  // Generation guard. refresh() has several concurrent drivers (the journal poll, the pane's
  // Refresh button, reconcile, and now vault deletes), and it AWAITS a cachedRead per governed
  // file — so a refresh that started BEFORE a delete can settle AFTER the delete-driven one and
  // republish a queue still containing the deleted note, reinstating the stale row. Rather than
  // skip concurrent runs (callers await refresh() and then act on the result — pollJournal's
  // auto-accept sweep does), each run takes a generation and only the NEWEST-STARTED run is
  // allowed to publish; an overtaken run does its reads and then drops its result on the floor.
  const myGen = (refreshGen.get(plugin) ?? 0) + 1;
  refreshGen.set(plugin, myGen);
  const notes: NoteSnapshot[] = [];
  for (const file of governedMarkdownFiles(plugin)) {
    notes.push({ path: file.path, content: await plugin.app.vault.cachedRead(file) });
  }
  const journal = await readJournal(plugin);
  const pending = computeQueue({
    notes,
    getBaseline: (p) => getStore(plugin).get(p),
    journal,
    // #224 governance watch: surface side-door drift over declared protected
    // properties for review (the drift is already inert — this makes it seen).
    protectedDrift: protectedPropertyDrift,
  });
  // Overtaken by a newer refresh while we were reading: that run has fresher input and will
  // publish its own result, so this one must not clobber it.
  if (refreshGen.get(plugin) !== myGen) return;
  cachedPending.set(plugin, pending);
  // #261: PUBLISH the pending index — the governance module owns the queue, so it owns the
  // published view of it too (`<plugin dir>/governance/pending-index.json`, the file
  // obsidian_pending_review reads; the retired standalone's stewardship path is dead since
  // #164). Same read-only DATA shape the standalone published (kernel pending-index.ts).
  // A publish failure must never break the refresh: log + continue. Gated on the LIVE mount
  // so a refresh still in flight when the module unmounts cannot re-create the file the
  // teardown just retracted (an unmounted module must read as not-published); the residual
  // window between this check and the write completing is a single already-issued write.
  if (mountedPlugins.has(plugin)) {
    try {
      await plugin.app.vault.adapter.write(
        paths(plugin).pendingIndexPath,
        serializePendingIndex(pending, new Date().toISOString()),
      );
    } catch (e) {
      console.error("governor acceptance: failed to publish pending index", e);
    }
  }
  updateBadge(plugin, pending.length);
  for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_GOVERNANCE)) {
    const view = leaf.view;
    if (view instanceof GovernanceReviewView) await view.rerender();
  }
}

function updateBadge(plugin: Plugin, count: number): void {
  const badgeEl = badgeEls.get(plugin);
  if (!badgeEl) return;
  if (badgeVisible(count, displaySettings(plugin).showRibbonBadge)) {
    badgeEl.setText(String(count));
    badgeEl.show();
  } else {
    badgeEl.hide();
  }
}

// Live-refresh tick: recompute the queue only when the vault-mcp journal has grown since the last
// tick. Read-only — advances no baseline. Reentrancy-guarded so a slow refresh never stacks.
async function pollJournal(plugin: Plugin): Promise<void> {
  const state = pollState(plugin);
  if (state.inFlight) return;
  let sig: string;
  try { sig = await journalSignature(plugin); } catch { return; }
  if (sig === state.lastSig) return;
  state.lastSig = sig;
  state.inFlight = true;
  try {
    await refresh(plugin);
    // After the queue is recomputed (agent write now visible in the flushed journal), try the ONE
    // automated exception on the freshly-known pending items. Any auto-accepts advance the
    // baseline via the same primitive Accept uses; refresh again so they leave the queue.
    const accepted = await sweepAutoAccept(plugin);
    if (accepted > 0) await refresh(plugin);
  } finally {
    state.inFlight = false;
  }
}

/**
 * #261 — the EVENT-DRIVEN drive for the queue refresh + auto-accept sweep. LIVE-DIAGNOSED:
 * Chromium/Electron background throttling suspends renderer timers while the Obsidian window
 * is occluded or unfocused, so the 2.5s poll interval above simply DOES NOT TICK during
 * unattended sessions — which is exactly when agents write. (Observed live: interval armed,
 * journal grown, zero ticks and zero refreshes for minutes with the window in the
 * background.) The journal only grows through this plugin's own kernel, so main.ts nudges
 * here right after every journal append — request handling is not throttled, so the sweep
 * runs even with the window buried. The interval stays as the foreground catch-up.
 *
 * Reachability: this changes WHEN the poll runs, never what it may accept — the decision
 * remains the eligibility engine over objective bytes (agents could already schedule the
 * poll indirectly, by writing; the journal-growth signature gate is unchanged). Not a
 * command, not a tool, not an instance method; a no-op unless governance is mounted.
 */
export function nudgeGovernanceQueue(plugin: Plugin): void {
  if (!mountedPlugins.has(plugin)) return;
  pollJournal(plugin).catch((e) => console.error("governor acceptance: journal-nudged poll failed", e));
}

// ── view activation ──────────────────────────────────────────────────────────
async function activateView(plugin: Plugin): Promise<void> {
  const existing = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_GOVERNANCE);
  let leaf: WorkspaceLeaf | null;
  if (existing.length) {
    leaf = existing[0];
  } else {
    leaf = plugin.app.workspace.getRightLeaf(false);
    await leaf?.setViewState({ type: VIEW_TYPE_GOVERNANCE, active: true });
  }
  if (leaf) plugin.app.workspace.revealLeaf(leaf);
  await refresh(plugin);
}

function injectStyles(component: Component): void {
  const css = `
  .governance-badge{position:absolute;top:2px;right:2px;min-width:16px;height:16px;
    padding:0 4px;border-radius:8px;background:var(--color-red,#e5484d);color:#fff;
    font-size:10px;line-height:16px;text-align:center;font-weight:600;}
  .governance-tab-icon-wrap{position:relative;}
  .governance-tab-badge{top:-4px;right:-6px;min-width:12px;height:12px;padding:0 3px;
    border-radius:6px;font-size:8px;line-height:12px;}
  .governance-pane{padding:8px;}
  .governance-header{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;}
  .governance-header h3{margin:0;flex:0 0 auto;}
  .governance-count{color:var(--text-muted);font-size:12px;flex:1;}
  .governance-refresh,.governance-back,.governance-adopt{font-size:12px;cursor:pointer;}
  .governance-empty{color:var(--text-muted);padding:16px 4px;}
  .governance-group{margin-bottom:12px;}
  .governance-group-agent{font-weight:600;font-size:12px;color:var(--text-accent);
    border-bottom:1px solid var(--background-modifier-border);padding:2px 0;margin-bottom:4px;}
  .governance-row{display:flex;justify-content:space-between;gap:8px;padding:6px 4px;
    border-radius:6px;cursor:pointer;}
  .governance-row:hover{background:var(--background-modifier-hover);}
  .governance-row-title{font-weight:500;}
  .governance-row-path{font-size:11px;color:var(--text-muted);}
  .governance-row-intent{font-size:11px;color:var(--text-muted);margin-top:2px;
    white-space:normal;word-break:break-word;}
  .governance-row-meta{display:flex;flex-direction:column;align-items:flex-end;
    font-size:11px;color:var(--text-muted);white-space:nowrap;}
  .governance-detail-title{margin:6px 0;}
  .governance-detail-sub{font-size:11px;color:var(--text-muted);margin-top:2px;}
  .governance-detail-intent{font-size:12px;color:var(--text-normal);margin-top:6px;
    white-space:pre-wrap;word-break:break-word;}
  .governance-intent-label{color:var(--text-muted);font-style:italic;}
  .governance-actions{display:flex;gap:8px;margin:10px 0;}
  .governance-allowlist{margin-top:16px;border-top:1px solid var(--background-modifier-border);
    padding-top:8px;}
  .governance-allowlist-title{font-weight:600;font-size:12px;margin-bottom:4px;}
  .governance-allowlist-desc{font-size:11px;color:var(--text-muted);margin-bottom:8px;}
  .governance-allowlist-row{margin-bottom:6px;}
  .governance-allowlist-label{font-size:12px;cursor:pointer;font-weight:500;}
  .governance-allowlist-why{font-size:11px;color:var(--text-muted);margin-left:20px;}
  .governance-diff{font-family:var(--font-monospace);font-size:12px;}
  .governance-diff-section{font-weight:600;margin:10px 0 4px;font-family:var(--font-interface);}
  .governance-fm-row{display:flex;gap:6px;padding:1px 0;align-items:baseline;}
  .governance-fm-key{font-weight:600;min-width:110px;}
  .governance-fm-val{flex:1;word-break:break-word;}
  .governance-fm-tag{font-size:10px;color:var(--text-muted);text-transform:uppercase;}
  .fm-added .governance-fm-key,.fm-new{color:var(--color-green,#3aa757);}
  .fm-removed .governance-fm-key,.fm-old{color:var(--color-red,#e5484d);}
  .fm-changed .governance-fm-key{color:var(--color-yellow,#d29922);}
  .governance-body{white-space:pre-wrap;}
  .governance-line{display:flex;gap:6px;}
  .governance-gutter{width:1ch;color:var(--text-muted);flex:0 0 auto;}
  .line-added{background:rgba(58,167,87,0.12);}
  .line-removed{background:rgba(229,72,77,0.12);}
  .word-changed{background:rgba(210,153,34,0.35);border-radius:2px;}
  .governance-collapsed{color:var(--text-faint);font-size:11px;text-align:center;
    padding:3px 0;cursor:pointer;user-select:none;}
  .governance-collapsed:hover{color:var(--text-muted);text-decoration:underline;}
  .governance-no-changes{color:var(--text-muted);font-style:italic;padding:4px 0;}
  .governance-nav{margin:6px 0;}
  .governance-open{font-size:12px;cursor:pointer;}
  .governance-mode{display:flex;gap:4px;margin:10px 0 6px;}
  .governance-mode-btn{font-size:11px;cursor:pointer;padding:2px 8px;border-radius:6px;
    border:1px solid var(--background-modifier-border);background:var(--background-primary);
    color:var(--text-normal);}
  .governance-mode-btn.is-active{background:var(--interactive-accent);color:var(--text-on-accent);
    border-color:var(--interactive-accent);}
  .governance-plain{white-space:pre-wrap;font-family:var(--font-monospace);font-size:12px;
    background:var(--background-secondary);padding:8px;border-radius:6px;overflow-x:auto;}
  .governance-history-toggle{font-size:12px;cursor:pointer;}
  .governance-history-sub{display:flex;align-items:center;gap:8px;margin-bottom:8px;
    font-size:12px;color:var(--text-muted);}
  .governance-history-clear{font-size:11px;cursor:pointer;}
  .governance-history-row{padding:5px 4px;border-bottom:1px solid
    var(--background-modifier-border);}
  .governance-history-head{display:flex;gap:8px;align-items:baseline;}
  .governance-history-kind{font-weight:600;font-size:11px;text-transform:uppercase;
    color:var(--text-accent);white-space:nowrap;}
  .history-revert .governance-history-kind{color:var(--color-red,#e5484d);}
  .history-accept .governance-history-kind{color:var(--color-green,#3aa757);}
  .governance-history-path{font-size:12px;word-break:break-word;}
  .governance-history-meta{display:flex;gap:10px;font-size:11px;color:var(--text-muted);
    flex-wrap:wrap;margin-top:1px;}
  .governance-history-hash{font-family:var(--font-monospace);}
  .governance-history-more{color:var(--text-faint);font-size:11px;text-align:center;
    padding:6px 0;}
  .history-request-changes .governance-history-kind{color:var(--color-yellow,#d29922);}
  .governance-revising,.governance-proposed{margin-top:16px;
    border-top:1px solid var(--background-modifier-border);padding-top:8px;}
  .governance-revising-title,.governance-proposed-title{font-weight:600;font-size:12px;
    margin-bottom:4px;}
  .governance-revising-desc,.governance-proposed-desc{font-size:11px;color:var(--text-muted);
    margin-bottom:8px;}
  .governance-revising-row,.governance-proposed-row{display:flex;justify-content:space-between;
    gap:8px;padding:6px 4px;border-radius:6px;align-items:center;}
  .governance-revising-controls,.governance-proposed-controls{display:flex;gap:6px;
    white-space:nowrap;}
  .governance-withdraw,.governance-request-changes{font-size:12px;cursor:pointer;}
  .governance-proposed-accept{font-size:12px;cursor:pointer;}
  .governance-request-text{width:100%;min-height:110px;font-size:13px;margin:8px 0;
    font-family:var(--font-interface);}
  `;
  const style = document.createElement("style");
  style.id = "vault-mcp-governance-styles";
  style.textContent = css;
  document.head.appendChild(style);
  component.register(() => style.remove());
}

/** Best-effort access to Obsidian's internal view registry — the ONE thing `plugin.registerView`
 * only tears down at plugin unload, so a LIVE unmount must unregister the type itself (its public
 * wrapper offers no un-register). Shape-typed, guarded at every call: an Obsidian build without it
 * degrades to "leave the type registered", handled by the reuse-on-duplicate path in wireGovernance. */
function viewRegistryOf(plugin: Plugin): { unregisterView(type: string): void } | undefined {
  const vr = (plugin.app as unknown as { viewRegistry?: { unregisterView?: (type: string) => void } }).viewRegistry;
  return typeof vr?.unregisterView === "function" ? (vr as { unregisterView(type: string): void }) : undefined;
}

/**
 * Wire the governance review pane + accept path into the host plugin. Called on mount — at onload
 * when the governance module is enabled, AND live when a human flips the module's enable toggle in
 * settings (main.ts `setGovernanceMounted`), with NO plugin reload. Everything it registers lands
 * on a CHILD Component (`plugin.addChild`) it returns, so a live unmount is `plugin.removeChild(it)`:
 * that runs every registered cleanup — detach open governance leaves + unregister the view type,
 * remove the ribbon element, detach the vault/DOM events, cancel the poll interval, clear the
 * debounce timers, and flip the `disposed` flag — exactly the machinery unload already used, now
 * scoped to a unit the plugin can dispose on demand. When the PLUGIN unloads it unloads its
 * children too, so the mounted case still tears down on unload as before.
 *
 * Adds NO accept surface to the plugin instance, the MCP transport, or any command — the accept
 * path is entirely closures behind gesture-gated pane buttons (see the REACHABILITY block at the
 * top of this file). Live mount/unmount changes only WHEN the pane exists, never HOW its controls
 * are reached: the accept-capable controller still lives only in the view's module-private WeakMap
 * (pane.ts `viewDeps`), so detaching the leaf on unmount drops the sole reference to it and no
 * dangling accept path survives.
 */
export async function wireGovernance(plugin: Plugin, deps: GovernanceWireDeps): Promise<Component> {
  const pluginDir = plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;
  const govDir = `${pluginDir}/governance`;
  pluginPaths.set(plugin, {
    baseDir: `${govDir}/baselines`,
    quarantineDir: `${govDir}/quarantine`,
    logPath: `${govDir}/acceptance-log.jsonl`,
    // The vault-mcp write journal — the SAME journal the kernel appends to. The pending queue is
    // derived from it, so an agent's MCP content-write is what surfaces a note for review.
    journalDir: `${pluginDir}/journal`,
    allowlistPath: `${govDir}/auto-accept-allowlist.json`,
    pendingIndexPath: `${govDir}/pending-index.json`,
    renameRecordsPath: `${govDir}/rename-records.json`,
  });
  configReaders.set(plugin, deps.getConfig);

  // The governance dir must exist before anything beside the baselines writes into it
  // (acceptance log appends, the published pending index, rename records).
  try {
    if (!(await plugin.app.vault.adapter.exists(govDir))) await plugin.app.vault.adapter.mkdir(govDir);
  } catch (e) {
    console.error("governor acceptance: failed to ensure governance dir", e);
  }

  const store = new BaselineStore(new AdapterBlobFs(plugin.app.vault.adapter), paths(plugin).baseDir);
  baselineStores.set(plugin, store);
  // All awaits happen BEFORE any registration below: if the store fails to load, nothing has been
  // registered and the caller (which never received a Component) has nothing to unmount.
  await store.load();

  await loadAllowlist(plugin);
  await loadRenameRecords(plugin);

  // The lifecycle scope for this mount. Every registration below lands on `component`, so
  // `plugin.removeChild(component)` is a complete, on-demand teardown. `addChild` also links it to
  // the plugin, so a plugin unload unloads it too.
  const component = new Component();
  plugin.addChild(component);

  injectStyles(component);

  // The review view. buildController() carries accept/revert/adopt/setClassEnabled; it is passed
  // straight into the view (which keeps it in a module-private WeakMap) and never stored on the
  // plugin. `registerView` THROWS on a duplicate type, so on a re-mount whose prior unmount could
  // not unregister (an Obsidian build without viewRegistry.unregisterView) we REUSE the existing
  // registration — its factory reads live WeakMap state, so the pane still works.
  try {
    plugin.registerView(VIEW_TYPE_GOVERNANCE, (leaf) => new GovernanceReviewView(leaf, buildController(plugin)));
  } catch (e) {
    console.warn("governor acceptance: review view type already registered — reusing it", e);
  }
  // Live-unmount teardown of the view: detach any open governance leaves (drops the sole reference
  // to their accept-capable controller) and unregister the type so a later re-mount can register
  // afresh. `plugin.registerView` also installs its own plugin-unload cleanup doing the same — a
  // harmless redundant no-op on the already-gone type at unload.
  component.register(() => {
    for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_GOVERNANCE)) leaf.detach();
    try { viewRegistryOf(plugin)?.unregisterView(VIEW_TYPE_GOVERNANCE); }
    catch (e) { console.warn("governor acceptance: view unregister failed", e); }
  });

  // Ribbon icon + badge. The ribbon only OPENS the pane (read-only navigation); it advances no
  // baseline. `addRibbonIcon` removes the element on plugin unload; we ALSO remove it on live
  // unmount via the component so a disable makes the gavel disappear without a reload.
  const ribbonEl = plugin.addRibbonIcon("gavel", "Acceptance review", async () => {
    await activateView(plugin);
  });
  component.register(() => ribbonEl.remove());
  ribbonEls.set(plugin, ribbonEl);
  const badgeEl = ribbonEl.createSpan({ cls: "governance-badge" });
  badgeEl.hide();
  badgeEls.set(plugin, badgeEl);

  // GENUINE human-input capture — the positive signal that gates the silent baseline advance. We
  // record a timestamp ONLY on real (isTrusted) browser input events (beforeinput/paste) on the
  // editor, attributed to the focused Markdown file. Programmatic vault.process/vault.modify writes
  // (how agents mutate notes over MCP) dispatch NO DOM input event, so an agent write never records
  // here. Registered via registerDomEvent so both listeners are torn down on unmount/unload.
  const onHumanInput = (evt: Event): void => {
    if (!evt.isTrusted) return;
    recordHumanInput(plugin);
  };
  component.registerDomEvent(document, "beforeinput", onHumanInput, { capture: true });
  component.registerDomEvent(document, "paste", onHumanInput, { capture: true });

  // Human-vs-agent edit reconciliation (silent human-edit baseline advance). The event closure
  // only schedules the module-scope reconcile; no reconcile method exists on the instance.
  component.registerEvent(plugin.app.vault.on("modify", (file) => {
    if (file instanceof TFile && file.extension === "md") scheduleReconcile(plugin, file);
  }));

  // CONFIRMED-rename capture — the link-heal detector's oracle. Records are plain data in a
  // module-private WeakMap; this confers no accept capability.
  component.registerEvent(plugin.app.vault.on("rename", (file, oldPath) => {
    if (file instanceof TFile) recordRename(plugin, file.path, oldPath);
  }));

  // DELETE → recompute the queue. The live-refresh poll only fires when the write JOURNAL grows,
  // and a human deleting a note in Obsidian writes no journal record — so without this the queue
  // kept offering Accept on a file that no longer exists until an unrelated agent write landed or
  // the user clicked Refresh. (An MCP delete DID self-heal, via the journal; the reported bug is
  // the human one.) The predicate is pure and tested (queue-invalidation.ts): only a deletion that
  // actually hits the cached queue pays for a recompute, so unrelated deletes stay free — and a
  // folder is matched as a segment-boundary prefix, since a folder delete does not reliably fire
  // a per-child event. Debounced through the SAME timer map the reconcile path uses (cleared by
  // the teardown hook below), so deleting a folder of pending notes coalesces into one refresh
  // instead of one per file.
  component.registerEvent(plugin.app.vault.on("delete", (file) => {
    const isFolder = file instanceof TFolder;
    if (!isFolder && !(file instanceof TFile && file.extension === "md")) return;
    // TWO reasons to recompute, with different reach — the pane shows three lists, not one:
    //  - the PENDING queue is cached and PUBLISHED (ribbon badge + pending-index.json, which
    //    obsidian_pending_review reads), so a delete that hits it must refresh even with the pane
    //    closed. That is the precise, cheap check.
    //  - the Proposed and Revising sections are LIVE reads (listProposed/listRevising, straight
    //    off the metadata cache), so their data is never stale — they simply never REPAINT. With a
    //    pane open, any governed delete therefore needs a rerender, or a deleted proposed note
    //    keeps its live Accept/Withdraw button. Gated on a pane actually being open so a closed
    //    pane still pays only for queue-hitting deletes.
    const paneOpen = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_GOVERNANCE).length > 0;
    const hitsQueue = deleteInvalidatesQueue(file.path, isFolder, getCachedPending(plugin).map((p) => p.path));
    if (!hitsQueue && !(paneOpen && !isExcluded(file.path))) return;
    const timers = timersFor(plugin);
    const key = QUEUE_DELETE_TIMER;
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      if (disposed) return; // an unmount between the delete and this tick
      void refresh(plugin).catch((e) =>
        console.error("vault-mcp governance: queue refresh after delete failed", e)
      );
    }, QUEUE_DELETE_DEBOUNCE_MS));
  }));

  // Right-click "Accept" (file explorer context menu) — a second entry point to the SAME
  // context-aware Accept the pane's Accept buttons call (acceptThroughGate), for the common
  // case of accepting one or more notes without opening the pane. Registered on `component`
  // like every other governance-mounted listener, so it lives/dies with the module toggle.
  // Single-file (`file-menu`) and multi-select (`files-menu`) are both wired; multi-select
  // loops the SAME single-path accept per file — there is no separate batch-accept primitive,
  // and looping keeps every file's stamp/baseline-advance/journal-record independent (one
  // failure does not block the rest).
  //
  // Gesture gate: EVERY accept-class handler in this codebase requires isRealGesture(evt),
  // and this is no exception, even though MenuItem.onClick's real runtime behavior for a
  // NATIVE (Electron OS) context menu vs. a DOM-rendered one is unverified — Obsidian's own
  // menu can render either way (Menu.setUseNativeMenu), and only a human physically
  // right-clicking can confirm which one this specific menu uses and whether its click event
  // is genuinely isTrusted. Gating defensively means the worst case if it turns out untrusted
  // is "the menu item does nothing" (fails closed, a UX bug) rather than silently bypassing
  // the one guarantee this whole module exists to uphold.
  const menuController = buildController(plugin);
  const eligibleMenuPaths = (): Set<string> =>
    computeAcceptEligiblePaths(menuController.getPending(), menuController.getProposed(), menuController.getRevising());
  const acceptViaMenu = async (path: string, title: string): Promise<void> => {
    try {
      const res = await acceptThroughGate(plugin.app, menuController, path, title);
      if (res === null) return; // gate: open/cancel — nothing happened
      new Notice(
        res.stamped
          ? `governor acceptance: accepted ${title} — stamped accepted-by: ${menuController.acceptedBy()}`
          : `governor acceptance: accepted ${title}`,
      );
      await menuController.refresh();
    } catch (e) {
      new Notice(`governor acceptance: accept failed — ${(e as Error).message}`);
    }
  };
  component.registerEvent(plugin.app.workspace.on("file-menu", (menu, file) => {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    if (!eligibleMenuPaths().has(file.path)) return;
    menu.addItem((item) => {
      item.setTitle("Accept").setIcon("check").onClick((evt) => {
        if (!isRealGesture(evt)) return; // inert on a forged/synthesized menu click
        void acceptViaMenu(file.path, file.basename);
      });
    });
  }));
  component.registerEvent(plugin.app.workspace.on("files-menu", (menu, files) => {
    const eligible = eligibleMenuPaths();
    const targets = files.filter(
      (f): f is TFile => f instanceof TFile && f.extension === "md" && eligible.has(f.path),
    );
    if (targets.length === 0) return;
    menu.addItem((item) => {
      item
        .setTitle(targets.length === 1 ? "Accept" : `Accept (${targets.length})`)
        .setIcon("check")
        .onClick((evt) => {
          if (!isRealGesture(evt)) return; // inert on a forged/synthesized menu click
          void (async () => {
            for (const f of targets) await acceptViaMenu(f.path, f.basename);
          })();
        });
    });
  }));

  // Clear the debounce timers on unmount/unload (Obsidian tears down views/events/dom-events/ribbon
  // automatically; the setTimeout handles are ours to clear). The same hook flips the disposed
  // flag below.
  let disposed = false;
  component.register(() => {
    disposed = true;
    // Drop the "mounted" flag so the settings-tab render falls back to its hint once this mount is
    // torn down (a disable, or plugin unload) — baselineStores keeps its stale entry, so this flag
    // is the accurate live-mount signal.
    mountedPlugins.delete(plugin);
    const timers = silentTimers.get(plugin);
    if (timers) { for (const t of timers.values()) clearTimeout(t); timers.clear(); }
    // #261: retract the published pending index on unmount — an unmounted governance module
    // must read as NOT-published (obsidian_pending_review's explicit `published: false`), never
    // as a stale-but-plausible queue. Best-effort + fire-and-forget: teardown is synchronous,
    // and a failed removal only leaves a stale file whose generatedAt betrays its age.
    void plugin.app.vault.adapter.remove(paths(plugin).pendingIndexPath).catch(() => {});
  });

  // Initial queue paint, then LIVE REFRESH: poll the vault-mcp write journal for growth and
  // recompute the queue when an agent write lands — so pending changes surface without a manual
  // Refresh click. The poll only STATS the journal each tick and only calls refresh() when the
  // journal actually grew; refresh() is read-only.
  //
  // `onLayoutReady` takes a plain callback and returns no EventRef, so `component.register` cannot
  // detach it. When mounting live (layout long ready) it runs immediately; when mounting at onload
  // before layout, an unmount in that window has already flushed the cleanups, so an interval
  // created afterward would leak: a 2.5s poll running pollJournal → sweepAutoAccept → setBaseline
  // (advancing baselines) on a torn-down mount. So the callback is gated on the `disposed` flag the
  // cleanup hook flips — the exact guard `wireUidIndex` uses. If disposed, do nothing (no refresh,
  // no interval).
  plugin.app.workspace.onLayoutReady(async () => {
    if (disposed) return;
    await refresh(plugin);
    try { pollState(plugin).lastSig = await journalSignature(plugin); } catch { /* first poll will refresh */ }
    if (disposed) return; // an unmount/unload may have landed during the awaited refresh above
    // #261: a rejection here must die in a console.error, never escape into the interval as an
    // unhandled rejection — the poll is the auto-accept sweep's only driver and it must survive
    // any one tick failing.
    component.registerInterval(window.setInterval(() => {
      pollJournal(plugin).catch((e) => console.error("governor acceptance: journal poll failed", e));
    }, JOURNAL_POLL_MS));
  });

  // Mark the mount live LAST — every await and registration above has succeeded, so the flag is
  // true only for a fully-wired mount (the settings-tab render can now show its controls). The
  // teardown hook deletes it.
  mountedPlugins.add(plugin);

  return component;
}

// ── settings-tab render (a SECOND gesture-gated home for adopt + auto-accept) ──
// The governance module EXPOSES this render function; connection-ui.ts calls it with a container
// and receives NOTHING back. This is what keeps the accept-capable controller module-private
// across the new surface: the controls are built HERE, inside the governance module, closing over
// the module-scope performAdopt / setClassEnabled / isClassEnabled — none of which is ever handed
// to connection-ui as a value it holds. connection-ui only ever passes a container element in.
//
// Same acceptance perimeter as the pane: the adopt button and each allowlist checkbox are wired
// via the SHARED wireAdoptButton / renderAllowlist (addEventListener only — `.onclick` stays null;
// gesture-gated via runGuardedAdopt / setClassEnabled → isRealGesture; adopt additionally
// confirmation-gated). Renders only when governance is MOUNTED (the controller/baseline store are
// live); when disabled/unmounted it renders a short hint and no controls.
export function renderGovernanceSettings(plugin: Plugin, containerEl: HTMLElement): void {
  if (!isGovernanceMounted(plugin)) {
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Enable governance (toggle above) to configure adopt-baseline and the auto-accept allowlist.",
    });
    return;
  }

  // Adopt-baseline — the same gesture- + confirmation-gated action as the pane's Adopt button,
  // shown here with its fuller description. The button holds no accept capability; wireAdoptButton
  // closes over the module-scope performAdopt, reached only when runGuardedAdopt reports "done".
  containerEl.createEl("h4", { text: "Adopt current state as baseline" });
  containerEl.createEl("p", { cls: "setting-item-description", text: ADOPT_BASELINE_DESC });
  const adoptBtn = containerEl.createEl("button", {
    cls: "mod-cta governance-adopt",
    text: "Adopt current state as baseline",
  });
  let adoptedCount = 0;
  wireAdoptButton(
    adoptBtn,
    () => confirmAdopt(plugin.app),
    async () => { adoptedCount = await performAdopt(plugin); },
    () => { new Notice(`governor acceptance: adopted baseline for ${adoptedCount} note(s).`); },
  );

  // Auto-accept allowlist — the SAME gesture-gated section the pane renders, built from the
  // module-scope allowlist state. setClassEnabled refuses any non-trusted click, so a forged /
  // synthesized click cannot flip a class (the checkbox reverts). No accept-capable object is
  // exposed: renderAllowlist receives only these three narrow module-scope thunks.
  renderGovernanceAllowlistSection(containerEl, plugin);
}

// The allowlist section for the settings tab — a thin adapter that hands the shared renderAllowlist
// only the three narrow, module-private thunks (never a controller, never an accept callable).
function renderGovernanceAllowlistSection(containerEl: HTMLElement, plugin: Plugin): void {
  renderAllowlist(containerEl, {
    authorizedClasses: () => AUTHORIZED_CLASSES,
    isClassEnabled: (id) => isClassEnabled(plugin, id),
    setClassEnabled: (id, on, evt) => setClassEnabled(plugin, id, on, evt),
  });
}
