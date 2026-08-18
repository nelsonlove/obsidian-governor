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
//    - performAccept   — module-scope fn; reached only via the pane Accept button click
//                        (gesture-gated). Never a method/field/command/tool.
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

import { Component, TFile, MarkdownView, Notice, type WorkspaceLeaf, type Plugin, type DataAdapter } from "obsidian";
import { BaselineStore, type BlobFs } from "../kernel/governance/baseline-store.js";
import { parseJournal, recentAgentWrite, agentWritesSince, type JournalRecord } from "../kernel/governance/journal-reader.js";
import { computeQueue, type PendingItem, type NoteSnapshot } from "../kernel/governance/queue.js";
import { classifyModify, shouldAdvanceBaselineSilently } from "../kernel/governance/classify.js";
import {
  acceptNote,
  revertNote,
  silentAdvanceRecord,
  type AcceptDeps,
  type LogRecord,
} from "../kernel/governance/accept.js";
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
import type { RenameIndex } from "../kernel/governance/auto-accept/detectors.js";
import { badgeVisible } from "../kernel/governance/badge.js";
import { governanceDisplaySettings } from "../kernel/governance/settings.js";
import { isRealGesture } from "../kernel/governance/gesture.js";
import {
  GovernanceReviewView,
  VIEW_TYPE_GOVERNANCE,
  confirmAdopt,
  renderAllowlist,
  wireAdoptButton,
  ADOPT_BASELINE_DESC,
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

/** What wireGovernance needs from the host plugin beyond the base Plugin surface: a reader for
 * the governance module's config (`settings.modules.governance.config`), from which the badge
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
  if (!s) throw new Error("vault-mcp governance: baseline store not initialised");
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
}
const pluginPaths = new WeakMap<Plugin, PluginPaths>();
function paths(plugin: Plugin): PluginPaths {
  const p = pluginPaths.get(plugin);
  if (!p) throw new Error("vault-mcp governance: paths not initialised");
  return p;
}

const configReaders = new WeakMap<Plugin, () => Record<string, unknown>>();
function displaySettings(plugin: Plugin) {
  return governanceDisplaySettings(configReaders.get(plugin)?.() ?? {});
}

const cachedPending = new WeakMap<Plugin, PendingItem[]>();
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
    console.error("vault-mcp governance: failed to persist auto-accept allowlist", e);
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
interface RenameRecord { oldTargets: Set<string>; newTargets: Set<string>; }
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
  renameRecordsFor(plugin).push({ oldTargets: linkTargetsOf(oldPath), newTargets: linkTargetsOf(newPath) });
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
function buildAcceptDeps(plugin: Plugin): AcceptDeps {
  return {
    readNote: (p) => readNote(plugin, p),
    writeNote: (p, c) => writeNote(plugin, p, c),
    store: {
      get: (p) => getStore(plugin).get(p),
      setBaseline: (p, c, by, at) => getStore(plugin).setBaseline(p, c, by, at),
    },
    quarantine: (p, c) => quarantineWrite(plugin, p, c),
    appendLog: (r) => appendLog(plugin, r),
    now: () => new Date().toISOString(),
    user: LOCAL_USER,
  };
}
async function performAccept(plugin: Plugin, path: string): Promise<void> {
  await acceptNote(buildAcceptDeps(plugin), path);
  await refresh(plugin);
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
function listRevising(plugin: Plugin): RevisingItem[] {
  const out: RevisingItem[] = [];
  for (const file of governedMarkdownFiles(plugin)) {
    const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
    if (fm?.["acceptance-status"] === "revising") out.push({ path: file.path, title: file.basename });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// The controller handed to the view. Carries accept/revert/adopt/setClassEnabled callables —
// passed straight into the view constructor (which stows it in a module-private WeakMap) and never
// stored on the plugin. Built fresh per view instantiation.
function buildController(plugin: Plugin): ReviewController {
  return {
    getPending: () => getCachedPending(plugin),
    getBaselineContent: (path) => getStore(plugin).get(path)?.content ?? null,
    readCurrent: (path) => readNote(plugin, path),
    accept: (path) => performAccept(plugin, path),
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
  };
}

// ── silent human-edit baseline advance (module-scope; driven by the vault modify event) ──
function scheduleReconcile(plugin: Plugin, file: TFile): void {
  const path = file.path;
  if (isExcluded(path)) return;
  const timers = timersFor(plugin);
  const existing = timers.get(path);
  if (existing) clearTimeout(existing);
  timers.set(path, setTimeout(() => { void reconcile(plugin, file); }, SILENT_ADVANCE_DEBOUNCE_MS));
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

    const result = evaluate(baseline.content, current, {
      enabled: getEnabledClasses(plugin),
      renameIndex: getRenameIndex(plugin),
    });
    if (!result.eligible) return false;

    const nowIso = new Date().toISOString();
    await store.setBaseline(path, current, "auto-accept", nowIso);
    await appendLog(plugin, autoAcceptRecord({
      ts: nowIso,
      path,
      fromHash,
      toHash,
      classes: result.classes,
      railResult: result.rail,
    }));
    return true;
  } catch {
    return false; // fail safe — never let an exception advance a baseline
  }
}
// Sweep the (agent-attributed) pending queue for auto-accept-eligible changes. Driven by the
// journal-growth poll (an interval timer, NOT agent-reachable).
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
  const notes: NoteSnapshot[] = [];
  for (const file of governedMarkdownFiles(plugin)) {
    notes.push({ path: file.path, content: await plugin.app.vault.cachedRead(file) });
  }
  const journal = await readJournal(plugin);
  const pending = computeQueue({
    notes,
    getBaseline: (p) => getStore(plugin).get(p),
    journal,
  });
  cachedPending.set(plugin, pending);
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
  .governance-revising{margin-top:16px;border-top:1px solid var(--background-modifier-border);
    padding-top:8px;}
  .governance-revising-title{font-weight:600;font-size:12px;margin-bottom:4px;}
  .governance-revising-desc{font-size:11px;color:var(--text-muted);margin-bottom:8px;}
  .governance-revising-row{display:flex;justify-content:space-between;gap:8px;padding:6px 4px;
    border-radius:6px;align-items:center;}
  .governance-revising-controls{display:flex;gap:6px;white-space:nowrap;}
  .governance-withdraw,.governance-request-changes{font-size:12px;cursor:pointer;}
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
  });
  configReaders.set(plugin, deps.getConfig);

  const store = new BaselineStore(new AdapterBlobFs(plugin.app.vault.adapter), paths(plugin).baseDir);
  baselineStores.set(plugin, store);
  // All awaits happen BEFORE any registration below: if the store fails to load, nothing has been
  // registered and the caller (which never received a Component) has nothing to unmount.
  await store.load();

  await loadAllowlist(plugin);

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
    console.warn("vault-mcp governance: review view type already registered — reusing it", e);
  }
  // Live-unmount teardown of the view: detach any open governance leaves (drops the sole reference
  // to their accept-capable controller) and unregister the type so a later re-mount can register
  // afresh. `plugin.registerView` also installs its own plugin-unload cleanup doing the same — a
  // harmless redundant no-op on the already-gone type at unload.
  component.register(() => {
    for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_GOVERNANCE)) leaf.detach();
    try { viewRegistryOf(plugin)?.unregisterView(VIEW_TYPE_GOVERNANCE); }
    catch (e) { console.warn("vault-mcp governance: view unregister failed", e); }
  });

  // Ribbon icon + badge. The ribbon only OPENS the pane (read-only navigation); it advances no
  // baseline. `addRibbonIcon` removes the element on plugin unload; we ALSO remove it on live
  // unmount via the component so a disable makes the gavel disappear without a reload.
  const ribbonEl = plugin.addRibbonIcon("gavel", "Governance review", async () => {
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
    component.registerInterval(window.setInterval(() => void pollJournal(plugin), JOURNAL_POLL_MS));
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
    () => { new Notice(`vault-mcp governance: adopted baseline for ${adoptedCount} note(s).`); },
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
