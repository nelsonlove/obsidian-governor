// The governance review pane — a right-sidebar ItemView. Lists pending notes grouped by agent;
// click a row to see the baseline-vs-current diff and the Accept / Revert buttons. Ported from
// obsidian-stewardship/src/view.ts as part of the governance (Acceptance) module fold (#83,
// cycle 2). This is the ONE obsidian-facing accept surface in vault-mcp.
//
// SECURITY: the Accept (queue detail view AND Proposed section — the ONE context-aware accept,
// #221/#164), Revert, Adopt-baseline AND auto-accept allowlist controls below are the
// ONLY call sites of the baseline-advance / allowlist-mutation code paths in the entire plugin;
// since the acceptance convergence the Accept click on a `proposed` note ALSO stamps the accepted
// family into the note's frontmatter (through the module-scope stampAcceptedFrontmatter in
// wiring.ts, reached only via deps.accept) — so this gesture perimeter now guards a real
// frontmatter WRITE, not just a baseline advance. The request-changes and withdraw dispositions
// (#101) keep the SAME gesture perimeter (their
// state transitions are agent-legal, but exercising them from this pane confers human standing).
// They are wired with `addEventListener('click', …)` — NEVER `el.onclick = …` — so the handler
// function is not a reachable property (`btn.onclick` stays null; renderer-JS cannot grab it to
// forge-call). Each handler additionally gates on `isRealGesture(evt)`, which requires a genuine
// `Event` whose isTrusted is true — a forged `{isTrusted:true}` plain object fails `instanceof
// Event`, and a synthesized `dispatchEvent(new MouseEvent(...))` has isTrusted forced false.
// Together only a physical human click fires accept/revert/adopt/setClassEnabled. Adopt-baseline
// additionally opens a confirmation modal because it silences the ENTIRE queue. See
// kernel/governance/gesture.ts and kernel/governance/accept.ts for the full invariant.
//
// REACHABILITY: the controller (which carries the accept/revert/adopt/setClassEnabled callables)
// is NOT stored as an instance field — a `private readonly controller` is an enumerable own
// property at runtime, so `getLeavesOfType(VIEW_TYPE_GOVERNANCE)[0].view.controller.accept(path)`
// would be a self-approval gadget for renderer-JS. Instead the controller lives in the
// module-scope `viewDeps` WeakMap below, keyed by the view instance. The WeakMap reference is
// module-private (unreachable from `app`), and its entries are not enumerable. The only live
// reference to an accept-capable callable is inside each button's addEventListener('click')
// closure, closed over the specific displayed row.

import { ItemView, Notice, Modal, TFile, type WorkspaceLeaf, type App } from "obsidian";
import { AcceptGateError, type AcceptOpts } from "../kernel/governance/accept.js";
import { type PendingItem, groupByAgent } from "../kernel/governance/queue.js";
import { diffNote, toHunks, type DiffLine, type HunkCollapsed } from "../kernel/governance/diff.js";
import { isRealGesture, runGuardedAdopt } from "../kernel/governance/gesture.js";
import { dispositionsFor, dispositionById, acceptEffectFor, type DispositionId } from "../kernel/governance/dispositions.js";
import type { AcceptResult } from "../kernel/governance/accept.js";
import type { ProposedItem } from "../kernel/governance/proposed.js";
import { badgeVisible } from "../kernel/governance/badge.js";
import { renderIntent } from "../kernel/governance/intent-view.js";
import type { ClassId, ClassSpec } from "../kernel/governance/auto-accept/classes.js";
import { buildHistory, renderHistoryEntries, HISTORY_DEFAULT_CAP } from "../kernel/governance/history.js";

/**
 * The pane's registered view type. Deliberately kept at the pre-0.12.0 string:
 * it is PERSISTED in `workspace.json`, so renaming it turns every open pane
 * into a dead leaf on upgrade — a real cost for zero user-visible benefit,
 * since the type is internal plumbing nobody reads. Historical spelling, like
 * the `governance_*` tool names and the `src/governance/` dirs; the module id
 * (`acceptance`), the pane title, and the ribbon label all carry the new name.
 */
export const VIEW_TYPE_GOVERNANCE = "governance-review";

/** One note currently in the revising state — plain display data for the Revising section. */
export interface RevisingItem {
  path: string;
  title: string;
}

export interface ReviewController {
  getPending(): PendingItem[];
  getBaselineContent(path: string): string | null;
  readCurrent(path: string): Promise<string>;
  // The ONE context-aware accept (#221/#164 convergence): advances the baseline, and — iff
  // the note is acceptance-status: proposed — first stamps the accepted family via
  // processFrontMatter, folding the stamp into the accepted snapshot. Returns whether it
  // stamped so the Notice can say so. Wired to the module-scope performAccept in wiring.ts.
  accept(path: string, opts?: AcceptOpts): Promise<AcceptResult>;
  /** The configured conformance-gate response mode (settings; "soft" default). */
  gateMode(): "soft" | "hard" | "off";
  revert(path: string): Promise<void>;
  // adopt-baseline: snapshots ALL current content as the reviewed baseline and clears the queue.
  // Wired to the module-scope performAdopt closure in wiring.ts — NOT a method on any instance and
  // NOT a command. Reachable only via a trusted-gesture UI handler that ALSO confirms (below).
  adopt(): Promise<void>;
  refresh(): Promise<void>;
  // Read-only badge-display setting (plain boolean — confers no accept capability).
  showTabBadge(): boolean;
  // ── auto-accept allowlist (HUMAN-ONLY-MUTABLE, gesture-gated) ──────────────
  // The set of ever-allowable mechanical classes (the frozen AUTHORIZED_CLASSES), each note's
  // current enabled state, and the ONE mutator — setClassEnabled — which does nothing unless
  // handed a real trusted gesture. Reached only from the pane's allowlist-checkbox click handler.
  authorizedClasses(): ReadonlyArray<ClassSpec>;
  isClassEnabled(id: ClassId): boolean;
  setClassEnabled(id: ClassId, on: boolean, evt: unknown): Promise<boolean>;
  // ── history (READ-ONLY) ────────────────────────────────────────────────────
  // The raw acceptance-log text for the display-only history browser ("" = genuinely empty,
  // null = the log exists but could not be read — shown as unavailable, never as empty).
  // Reading the log confers nothing: no accept capability rides on it, the pane never writes it.
  readAcceptanceLog(): Promise<string | null>;
  // ── revision round-trip (#101; HUMAN dispositions, gesture-gated at their call sites) ──
  // request-changes: acceptance-status → revising + a [!revision-request] callout below the
  // note's H1 carrying `text`. withdraw: remove the [!revision-request] callout(s) and set
  // acceptance-status → proposed. Both wired to module-scope functions in wiring.ts (the
  // performAdopt pattern) — never a command, method, or MCP tool; reached ONLY from the
  // addEventListener + isRealGesture handlers below. NOT accept-equivalent (they write the
  // agent-legal revising/proposed transitions and advance no baseline), but they confer
  // standing ("a human asked for changes"), so they keep the full gesture perimeter.
  requestChanges(path: string, text: string): Promise<void>;
  withdraw(path: string): Promise<void>;
  // Read-only listing of notes with `acceptance-status: revising` (metadata cache) for the
  // Revising section. Plain data — confers no capability.
  getRevising(): RevisingItem[];
  // ── acceptance convergence (#221/#164) — all three are plain READ-ONLY data ──
  // The Proposed section listing: `acceptance-status: proposed` notes with NO pending write
  // delta (pending items are deduped out — their queue row already carries Accept), built
  // from the metadata cache like getRevising and respecting the same excluded roots.
  getProposed(): ProposedItem[];
  // The configured accepted-by identity (governance config `acceptedBy`) — display data so
  // the Accept controls can SURFACE what will be stamped before the one click.
  acceptedBy(): string;
  // One note's `acceptance-status` from the metadata cache — display data for the same
  // context-aware surfacing (proposed ⇒ "will stamp", else ⇒ "baseline only").
  acceptanceStatus(path: string): string | null;
  // ── protected properties (#135/#224) — READ-ONLY display data ──────────────
  // The HONORED per-note auto-accept policy ("appends" | "all" | null), derived from the
  // blessed BASELINE frontmatter (honor-only-if-blessed) — never the raw current note. The
  // pane only BADGES it; the human sets it by editing the note's frontmatter (their editor
  // write is human-attributed and therefore honored). No toggle here, deliberately.
  honoredAutoAccept(path: string): string | null;
}

// Confirmation modal for the mass-silencing adopt-baseline action. Opens on a human gesture,
// resolves true only when the human clicks Continue (itself gesture-gated), false on Cancel /
// Escape / backdrop.
class ConfirmModal extends Modal {
  private decided = false;
  constructor(
    app: App,
    private readonly opts: { title: string; body: string; confirmText: string },
    private readonly resolve: (ok: boolean) => void,
  ) {
    super(app);
  }
  private settle(ok: boolean): void {
    if (this.decided) return;
    this.decided = true;
    this.resolve(ok);
  }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.opts.title });
    contentEl.createEl("p", { text: this.opts.body });
    const row = contentEl.createDiv({ cls: "governance-actions" });
    const cancel = row.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
    const confirm = row.createEl("button", { cls: "mod-warning governance-adopt-confirm", text: this.opts.confirmText });
    // The confirm button is itself an accept-class handler → wired via addEventListener (so its
    // onclick is null and the function is unreachable) and gated on isRealGesture (a forged object
    // or synthesized click must not slip past the human-confirmation gate). The listener is torn
    // down with the modal's contentEl on close.
    confirm.addEventListener("click", (evt) => {
      if (!isRealGesture(evt)) return;
      this.settle(true);
      this.close();
    });
  }
  onClose(): void {
    this.settle(false); // Escape / backdrop / Cancel all resolve as "did not confirm".
    this.contentEl.empty();
  }
}

// The exact adopt-baseline confirmation flow. Returns true only if the human confirmed.

// ── the soft conformance gate (Nelson's ruling, 2026-08-19) ───────────────────
// The kernel's gate refuses an under-filled `proposed` note (AcceptGateError,
// nothing written). Instead of a dead-end Notice, the pane turns that refusal
// into a three-way HUMAN choice: Accept anyway (a second real gesture — the
// only path to `gateOverride`, unreachable to any transport since accept
// itself is), Open note (go fix the missing fields), or Cancel. The modal
// holds no capability: the override runs in the SAME gesture-gated closure
// that owns the accept call.
class GateModal extends Modal {
  private decided = false;
  constructor(
    app: App,
    private readonly title_: string,
    private readonly missing: string[],
    private readonly done: (choice: "accept" | "open" | null) => void,
  ) { super(app); }
  onOpen(): void {
    this.titleEl.setText("Missing required frontmatter");
    this.contentEl.createEl("p", {
      text: `${this.title_} is missing: ${this.missing.join(", ")}.`,
    });
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Accept it as-is, open it to fill the fields in, or cancel.",
    });
    const row = this.contentEl.createDiv({ cls: "modal-button-container" });
    const mk = (text: string, cls: string, choice: "accept" | "open" | null) => {
      const b = row.createEl("button", { text, cls });
      b.addEventListener("click", (evt) => {
        if (!isRealGesture(evt)) return; // forged/synthesized click is inert
        this.decided = true;
        this.close();
        this.done(choice);
      });
      return b;
    };
    mk("Accept anyway", "mod-warning", "accept");
    mk("Open note", "", "open");
    mk("Cancel", "", null);
  }
  onClose(): void {
    if (!this.decided) this.done(null); // Escape / backdrop = cancel
    this.contentEl.empty();
  }
}

/**
 * Run an accept through the soft gate: on AcceptGateError, ask the human.
 * Returns the result, or null when nothing was accepted (open / cancel).
 * Any non-gate error rethrows to the caller's existing handler.
 */
async function acceptThroughGate(
  app: App,
  deps: ReviewController,
  path: string,
  title: string,
): Promise<AcceptResult | null> {
  try {
    return await deps.accept(path);
  } catch (e) {
    // "hard" mode keeps today's behavior: the refusal surfaces via the caller's
    // Notice handler. ("off" never throws the gate — wiring empties the key list.)
    if (!(e instanceof AcceptGateError) || deps.gateMode() === "hard") throw e;
    const choice = await new Promise<"accept" | "open" | null>((resolve) =>
      new GateModal(app, title, e.missing, resolve).open(),
    );
    if (choice === "accept") return await deps.accept(path, { gateOverride: true });
    if (choice === "open") {
      await app.workspace.openLinkText(path, "", false);
      return null;
    }
    return null;
  }
}

export function confirmAdopt(app: App): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmModal(
      app,
      {
        title: "Adopt current state as baseline",
        body: "This accepts all current content as the reviewed baseline and clears the queue. Continue?",
        confirmText: "Adopt baseline",
      },
      resolve,
    ).open();
  });
}

// Free-text modal for the request-changes disposition (#101). Opens on a human gesture from the
// pane; resolves the reviewer's text only when the human clicks the confirm button — which is
// itself gesture-gated (addEventListener + isRealGesture, the ConfirmModal discipline), so a
// forged/synthesized click cannot submit the modal any more than it could open it. Cancel /
// Escape / backdrop resolve null (nothing happens). The modal itself holds NO capability: it
// only collects text; the state change runs in the button handler that opened it.
class RequestChangesModal extends Modal {
  private decided = false;
  constructor(
    app: App,
    private readonly noteTitle: string,
    private readonly resolve: (text: string | null) => void,
  ) {
    super(app);
  }
  private settle(text: string | null): void {
    if (this.decided) return;
    this.decided = true;
    this.resolve(text);
  }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Request changes" });
    contentEl.createEl("p", {
      text:
        `Describe the changes you want on “${this.noteTitle}”. On confirm the note's acceptance-status ` +
        "becomes “revising” and this text is inserted into the note as a [!revision-request] callout " +
        "below its H1 — a revising agent reads it there, in the note body.",
    });
    const input = contentEl.createEl("textarea", {
      cls: "governance-request-text",
      attr: { rows: "6", placeholder: "What should change, and why…" },
    });
    const row = contentEl.createDiv({ cls: "governance-actions" });
    const cancel = row.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
    const confirm = row.createEl("button", { cls: "mod-cta governance-request-confirm", text: "Request changes" });
    confirm.addEventListener("click", (evt) => {
      if (!isRealGesture(evt)) return;
      const text = input.value.trim();
      if (!text) return; // nothing to request — keep the modal open for the human to type or cancel
      this.settle(text);
      this.close();
    });
  }
  onClose(): void {
    this.settle(null); // Escape / backdrop / Cancel all resolve as "no request"
    this.contentEl.empty();
  }
}

// The exact request-changes text-capture flow. Resolves the text only on a confirmed gesture.
// Module-private on purpose: nothing outside the pane needs it, so nothing outside can open it.
function promptRequestChanges(app: App, noteTitle: string): Promise<string | null> {
  return new Promise((resolve) => {
    new RequestChangesModal(app, noteTitle, resolve).open();
  });
}

// ── SINGLE-SOURCED accept-class control text + wiring ─────────────────────────
// The two accept-equivalent controls (adopt-baseline + the auto-accept allowlist) appear in TWO
// human surfaces now — the review pane AND the settings tab (governance/wiring.ts
// renderGovernanceSettings). To keep them from drifting, both their descriptive copy and their
// gesture-gated wiring live here as ONE implementation each; both surfaces import these.

// The auto-accept allowlist description. FULLER than a one-liner on purpose — it must state that
// everything non-mechanical stays PENDING FOR REVIEW and that this is a human setup action, never
// a command / never agent-invokable (the acceptance perimeter, restated at the control). Shared by
// renderAllowlist (below) so the pane and the settings tab render the identical text.
export const AUTO_ACCEPT_DESC =
  "Auto-accept advances a note's baseline WITHOUT a human click, but ONLY for changes that are " +
  "provably mechanical and belong to a class enabled below. Everything else stays pending for " +
  "review. Disabling a class makes its changes stay pending. This is a human setup action — " +
  "never a command, never agent-invokable.";

// The adopt-baseline description, shared by the settings tab (which shows it as a paragraph) and
// referenced by the pane (as the adopt button's tooltip) so the two cannot drift.
export const ADOPT_BASELINE_DESC =
  "Adopt current state as baseline: snapshots all current content as the reviewed baseline and " +
  "clears the review queue. This is a human setup action — never a command, never agent-invokable.";

// The subset of the controller the allowlist section needs: the frozen universe of classes, each
// one's current enabled state, and the ONE gesture-gated mutator. NO accept/revert/adopt here —
// this is deliberately narrow so a settings-tab caller hands over only allowlist authority (itself
// gesture-gated), never the full accept-capable controller.
export interface AllowlistDeps {
  authorizedClasses(): ReadonlyArray<ClassSpec>;
  isClassEnabled(id: ClassId): boolean;
  setClassEnabled(id: ClassId, on: boolean, evt: unknown): Promise<boolean>;
}

// The ONE auto-accept allowlist renderer — HUMAN-ONLY-MUTABLE. Each checkbox is gesture-gated:
// wired via addEventListener (its `.onclick` stays null → the handler is unreachable to
// renderer-JS) whose handler refuses unless the click is a genuine trusted gesture
// (deps.setClassEnabled → isRealGesture). A synthesized/forged click is rejected and the checkbox
// reverts to the real enabled state. The universe of classes is the frozen AUTHORIZED_CLASSES —
// this UI can only enable/disable among them, never add a new class. Called by BOTH the review
// pane and the settings tab, so there is one implementation, not two that can drift.
export function renderAllowlist(root: HTMLElement, deps: AllowlistDeps): void {
  const section = root.createDiv({ cls: "governance-allowlist" });
  section.createDiv({ cls: "governance-allowlist-title", text: "Auto-accept (mechanical changes)" });
  section.createDiv({ cls: "governance-allowlist-desc", text: AUTO_ACCEPT_DESC });
  for (const spec of deps.authorizedClasses()) {
    const row = section.createDiv({ cls: "governance-allowlist-row" });
    const label = row.createEl("label", { cls: "governance-allowlist-label" });
    const checkbox = label.createEl("input", { type: "checkbox", cls: "governance-allowlist-check" });
    checkbox.checked = deps.isClassEnabled(spec.id);
    label.createSpan({ cls: "governance-allowlist-name", text: ` ${spec.id}` });
    row.createDiv({ cls: "governance-allowlist-why", text: spec.railNeutralBecause });
    // Gesture-gated: only a genuine trusted click mutates the allowlist. A forged/synthesized
    // click is refused and the checkbox is reverted to the real enabled state.
    checkbox.addEventListener("click", async (evt) => {
      const want = checkbox.checked;
      const applied = await deps.setClassEnabled(spec.id, want, evt);
      if (!applied) {
        evt.preventDefault();
        checkbox.checked = deps.isClassEnabled(spec.id); // revert to real state
      }
    });
  }
}

// The ONE adopt-baseline button wiring — gesture- AND confirmation-gated. The button is wired via
// addEventListener (its `.onclick` stays null → unreachable to renderer-JS); the handler runs the
// action ONLY when runGuardedAdopt reports "done" (a real trusted gesture AND a human confirm).
// `onDone` fires on success only (Notice + rerender in the pane; Notice in the settings tab).
// Called by BOTH surfaces, so the gesture+confirm gate is one implementation, not two.
export function wireAdoptButton(
  btn: HTMLElement,
  confirm: () => Promise<boolean>,
  adopt: () => Promise<void>,
  onDone: () => void | Promise<void>,
): void {
  btn.addEventListener("click", async (evt) => {
    const outcome = await runGuardedAdopt(evt, confirm, adopt);
    if (outcome === "done") await onDone();
  });
}

// Per-disposition button classes for the descriptor-driven action row. Pure display data (CSS
// class strings) keyed by descriptor id — the descriptors themselves stay style-free.
const DISPOSITION_BTN_CLS: Partial<Record<DispositionId, string>> = {
  accept: "mod-cta governance-accept",
  revert: "governance-revert",
  "request-changes": "governance-request-changes",
};

// Module-private store of each view's controller. Not reachable by walking the view object:
// `viewDeps` is a module-local binding, and WeakMap entries cannot be enumerated. This is
// what keeps accept/revert/adopt/setClassEnabled off the app-reachable object graph.
const viewDeps = new WeakMap<GovernanceReviewView, ReviewController>();

export class GovernanceReviewView extends ItemView {
  private selected: string | null = null;
  // Which rendering the detail view shows: the unified Diff (default), the Before (baseline
  // content) or the After (current content). Read-only display state — confers no capability.
  private detailMode: "diff" | "before" | "after" = "diff";
  // Whether the pane shows the review queue or the read-only history browser, and the optional
  // per-note history filter (set when history is opened from a note's detail). Pure display
  // state — the history view holds no accept capability and never mutates the log.
  private paneMode: "queue" | "history" = "queue";
  private historyFilter: string | null = null;
  // The pending-count badge overlaid on this view's TAB HEADER icon (read-only display element —
  // confers no capability).
  private tabBadgeEl: HTMLElement | null = null;
  private tabIconUnavailableWarned = false;

  constructor(leaf: WorkspaceLeaf, controller: ReviewController) {
    super(leaf);
    viewDeps.set(this, controller);
  }

  getViewType(): string { return VIEW_TYPE_GOVERNANCE; }
  getDisplayText(): string { return "Acceptance review"; }
  getIcon(): string { return "gavel"; }

  async onOpen(): Promise<void> { await this.rerender(); }
  async onClose(): Promise<void> {
    if (this.tabBadgeEl) {
      this.tabBadgeEl.remove();
      this.tabBadgeEl = null;
    }
  }

  // Reach the tab header's icon element via this.leaf. Not part of the public Obsidian typings,
  // so this is a best-effort lookup with a fallback and a graceful, once-only failure mode — it is
  // purely a display target (badge overlay), never a capability surface.
  private getTabIconEl(): HTMLElement | null {
    const leafAny = this.leaf as unknown as {
      tabHeaderInnerIconEl?: HTMLElement;
      tabHeaderEl?: HTMLElement;
    };
    const el =
      leafAny.tabHeaderInnerIconEl ??
      leafAny.tabHeaderEl?.querySelector<HTMLElement>(".workspace-tab-header-inner-icon") ??
      null;
    if (!el && !this.tabIconUnavailableWarned) {
      this.tabIconUnavailableWarned = true;
      console.warn(
        "governor acceptance: tab header icon element not reachable in this Obsidian version — " +
          "the review-pane tab badge is disabled; the ribbon badge is unaffected.",
      );
    }
    return el;
  }

  private updateTabBadge(count: number, enabled: boolean): void {
    const iconEl = this.getTabIconEl();
    if (!iconEl) return;
    if (!this.tabBadgeEl) {
      iconEl.addClass("governance-tab-icon-wrap");
      this.tabBadgeEl = iconEl.createSpan({ cls: "governance-badge governance-tab-badge" });
    }
    if (badgeVisible(count, enabled)) {
      this.tabBadgeEl.setText(String(count));
      this.tabBadgeEl.show();
    } else {
      this.tabBadgeEl.hide();
    }
  }

  async rerender(): Promise<void> {
    const deps = viewDeps.get(this)!;
    const root = this.contentEl;
    root.empty();
    root.addClass("governance-pane");
    const pending = deps.getPending();
    this.updateTabBadge(pending.length, deps.showTabBadge());

    const header = root.createDiv({ cls: "governance-header" });
    header.createEl("h3", { text: "Acceptance" });
    header.createSpan({ cls: "governance-count", text: `${pending.length} pending` });
    const refreshBtn = header.createEl("button", { cls: "governance-refresh", text: "Refresh" });
    refreshBtn.onclick = async () => { await deps.refresh(); await this.rerender(); };

    // Queue ⇄ History toggle. The history browser is DISPLAY-ONLY (it reads the acceptance log
    // and renders text nodes; no accept capability, no log mutation), so a plain onclick is safe
    // here — this is read-only navigation, not an accept-class control.
    const historyBtn = header.createEl("button", {
      cls: "governance-history-toggle",
      text: this.paneMode === "history" ? "Queue" : "History",
    });
    historyBtn.onclick = () => {
      this.paneMode = this.paneMode === "history" ? "queue" : "history";
      if (this.paneMode === "queue") this.historyFilter = null;
      void this.rerender();
    };

    if (this.paneMode === "history") {
      await this.renderHistory(root, deps);
      return;
    }

    // Adopt-baseline is a genuine-user-gesture UI action (NOT a command, NOT an instance method).
    // It closes over `deps.adopt` here; the handler is wired via addEventListener (onclick stays
    // null → the function is unreachable to renderer-JS) and is gesture-gated AND confirmation-
    // gated, since adopting silences the whole queue.
    const adoptBtn = header.createEl("button", { cls: "governance-adopt", text: "Adopt baseline" });
    adoptBtn.title = ADOPT_BASELINE_DESC; // same single-sourced copy the settings tab shows
    // Gesture- AND confirmation-gated via the shared wireAdoptButton (one implementation, shared
    // with the settings tab). onDone fires only on a confirmed real gesture.
    wireAdoptButton(
      adoptBtn,
      () => confirmAdopt(this.app),
      () => deps.adopt(),
      async () => {
        new Notice("governor acceptance: baseline adopted — the vault is now reviewable.");
        await this.rerender();
      },
    );

    if (this.selected && pending.some((p) => p.path === this.selected)) {
      await this.renderDetail(root, pending.find((p) => p.path === this.selected)!);
    } else {
      this.selected = null;
      this.renderList(root, pending);
      // The Proposed section (#221/#164): acceptance-status: proposed notes with NO pending
      // write delta, each carrying the SAME context-aware Accept (and Request changes…) the
      // queue rows do — the convergence that makes the pane's Accept the ONE accept across
      // both lifecycles. Pending proposed notes are deduped into the queue only.
      this.renderProposed(root, deps);
      // The Revising section (#101): notes with acceptance-status: revising, whether or not
      // they are in the pending queue — the frontmatter-lifecycle visibility that makes this
      // pane a superset of the retired js-engine panel.
      this.renderRevising(root, deps);
      // The auto-accept allowlist section — HUMAN-ONLY-MUTABLE, gesture-gated. Rendered via the
      // shared renderAllowlist (one implementation, shared with the settings tab).
      renderAllowlist(root, deps);
    }
  }

  // The Proposed section (#221/#164) — notes whose frontmatter says `acceptance-status:
  // proposed` (metadata cache) that have no pending write delta. Two row actions, BOTH the
  // full authority-class perimeter (addEventListener-wired so .onclick stays null +
  // isRealGesture-gated; the accept.ts discipline):
  //   - Accept: the SAME context-aware accept as the queue detail view (deps.accept →
  //     module-scope performAccept). The button's tooltip surfaces what will be stamped
  //     (acceptEffectFor) — still exactly one click.
  //   - Request changes…: the existing #101 disposition (modal text capture, then
  //     deps.requestChanges → performRequestChanges).
  private renderProposed(root: HTMLElement, deps: ReviewController): void {
    let items: ProposedItem[] = [];
    try {
      items = deps.getProposed();
    } catch {
      items = [];
    }
    if (items.length === 0) return;
    const acceptDesc = dispositionById("accept")!;
    const requestDesc = dispositionById("request-changes")!;
    const identity = deps.acceptedBy();
    const section = root.createDiv({ cls: "governance-proposed" });
    section.createDiv({ cls: "governance-proposed-title", text: `Proposed (${items.length})` });
    // Surface the stamp up front: accepting from this section writes the accepted family
    // into the note (the one in-app human write path), with the configured identity.
    section.createDiv({
      cls: "governance-proposed-desc",
      text:
        "Notes proposed for acceptance with no pending write delta. Accept stamps " +
        `acceptance-status: accepted (accepted-by: ${identity}, accepted-on: minutes precision) ` +
        "into the note and advances its baseline.",
    });
    for (const item of items) {
      const row = section.createDiv({ cls: "governance-proposed-row" });
      const main = row.createDiv({ cls: "governance-row-main" });
      main.createDiv({ cls: "governance-row-title", text: item.title });
      main.createDiv({ cls: "governance-row-path", text: item.path });
      const controls = row.createDiv({ cls: "governance-proposed-controls" });
      // Open in tab — read-only navigation; plain onclick is safe (confers nothing).
      const openBtn = controls.createEl("button", { cls: "governance-open", text: "Open" });
      openBtn.onclick = async () => {
        const file = this.app.vault.getAbstractFileByPath(item.path);
        if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
      };
      // Accept — the ONE context-aware accept, gesture-gated exactly like the queue's.
      const proposedAcceptBtn = controls.createEl("button", {
        cls: "mod-cta governance-proposed-accept",
        text: acceptDesc.label,
      });
      proposedAcceptBtn.title = acceptEffectFor("proposed", identity);
      proposedAcceptBtn.addEventListener("click", async (evt) => {
        if (!isRealGesture(evt)) return; // inert on forged arg or synthesized click
        proposedAcceptBtn.disabled = true;
        try {
          const res = await acceptThroughGate(this.app, deps, item.path, item.title);
          if (res === null) { proposedAcceptBtn.disabled = false; return; } // gate: open/cancel — nothing happened
          new Notice(
            res.stamped
              ? `governor acceptance: accepted ${item.title} — stamped accepted-by: ${identity}`
              : `governor acceptance: accepted ${item.title}`,
          );
          await this.rerender();
        } catch (e) {
          new Notice(`governor acceptance: accept failed — ${(e as Error).message}`);
          proposedAcceptBtn.disabled = false;
        }
      });
      // Request changes… — the existing disposition, same modal + gesture perimeter.
      const proposedRequestBtn = controls.createEl("button", {
        cls: "governance-request-changes",
        text: requestDesc.label,
      });
      proposedRequestBtn.addEventListener("click", async (evt) => {
        if (!isRealGesture(evt)) return; // inert on forged arg or synthesized click
        const text = await promptRequestChanges(this.app, item.title);
        if (text === null) return; // cancelled — nothing changes
        proposedRequestBtn.disabled = true;
        try {
          await deps.requestChanges(item.path, text);
          new Notice(`governor acceptance: requested changes on ${item.title}`);
          await this.rerender();
        } catch (e) {
          new Notice(`governor acceptance: request-changes failed — ${(e as Error).message}`);
          proposedRequestBtn.disabled = false;
        }
      });
    }
  }

  // The Revising section — notes whose frontmatter says `acceptance-status: revising` (from the
  // metadata cache), each with an Open link (read-only navigation) and the withdraw disposition.
  // Withdraw is a HUMAN disposition (gesture-gated, addEventListener-wired): it removes the
  // [!revision-request] callout(s) the pane inserted and sets acceptance-status back to proposed.
  private renderRevising(root: HTMLElement, deps: ReviewController): void {
    let items: RevisingItem[] = [];
    try {
      items = deps.getRevising();
    } catch {
      items = [];
    }
    if (items.length === 0) return;
    const withdrawDesc = dispositionById("withdraw")!;
    const section = root.createDiv({ cls: "governance-revising" });
    section.createDiv({ cls: "governance-revising-title", text: `Revising (${items.length})` });
    // Careful copy: `acceptance-status: revising` is an agent-legal frontmatter value, so this
    // section reports the STATE, not provenance — the acceptance log is what records who actually
    // requested changes. No capability rides on the listing either way.
    section.createDiv({
      cls: "governance-revising-desc",
      text: "Notes in the revising state — review feedback lives in each note's [!revision-request] callout.",
    });
    for (const item of items) {
      const row = section.createDiv({ cls: "governance-revising-row" });
      const main = row.createDiv({ cls: "governance-row-main" });
      main.createDiv({ cls: "governance-row-title", text: item.title });
      main.createDiv({ cls: "governance-row-path", text: item.path });
      const controls = row.createDiv({ cls: "governance-revising-controls" });
      // Open in tab — read-only navigation, same as the detail view's button; plain onclick is
      // safe here (opening a file confers nothing renderer-JS lacks).
      const openBtn = controls.createEl("button", { cls: "governance-open", text: "Open" });
      openBtn.onclick = async () => {
        const file = this.app.vault.getAbstractFileByPath(item.path);
        if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
      };
      // withdraw (#101) — gesture-gated (addEventListener + isRealGesture; the shared
      // authority-class discipline). Reaches the module-scope performWithdraw via deps only.
      const withdrawBtn = controls.createEl("button", { cls: "governance-withdraw", text: withdrawDesc.label });
      withdrawBtn.addEventListener("click", async (evt) => {
        if (!isRealGesture(evt)) return; // inert on forged arg or synthesized click
        withdrawBtn.disabled = true;
        try {
          await deps.withdraw(item.path);
          new Notice(`governor acceptance: withdrew the revision request on ${item.title}`);
          await this.rerender();
        } catch (e) {
          new Notice(`governor acceptance: withdraw failed — ${(e as Error).message}`);
          withdrawBtn.disabled = false;
        }
      });
    }
  }

  // The read-only history browser: past decisions from the acceptance log, newest first, capped,
  // optionally filtered to one note. Display-only — every log-derived string lands in a text node
  // (renderHistoryEntries, kernel/governance/history.ts), and nothing here can accept, revert, or
  // write the log.
  private async renderHistory(root: HTMLElement, deps: ReviewController): Promise<void> {
    const sub = root.createDiv({ cls: "governance-history-sub" });
    if (this.historyFilter) {
      // The filter path is agent-influenced — text node only.
      sub.createSpan({ cls: "governance-history-filter", text: `History for: ${this.historyFilter}` });
      const clearBtn = sub.createEl("button", { cls: "governance-history-clear", text: "Show all" });
      clearBtn.onclick = () => { this.historyFilter = null; void this.rerender(); };
    } else {
      sub.createSpan({ cls: "governance-history-filter", text: "All recorded decisions" });
    }
    let logText: string | null = null;
    try { logText = await deps.readAcceptanceLog(); } catch { logText = null; }
    if (logText === null) {
      // An unreadable audit log must NOT render as a clean empty history — that would silently
      // hide every recorded decision from the human auditing them.
      root.createDiv({
        cls: "governance-empty",
        text: "History unavailable — the acceptance log could not be read.",
      });
      return;
    }
    const view = buildHistory(logText, { cap: HISTORY_DEFAULT_CAP, path: this.historyFilter });
    renderHistoryEntries(root, view);
  }

  private renderList(root: HTMLElement, pending: PendingItem[]): void {
    if (pending.length === 0) {
      root.createDiv({ cls: "governance-empty", text: "Queue empty — no agent changes awaiting review." });
      return;
    }
    for (const group of groupByAgent(pending)) {
      const g = root.createDiv({ cls: "governance-group" });
      g.createDiv({ cls: "governance-group-agent", text: group.agent });
      for (const item of group.items) {
        const row = g.createDiv({ cls: "governance-row" });
        const main = row.createDiv({ cls: "governance-row-main" });
        main.createDiv({ cls: "governance-row-title", text: item.title });
        main.createDiv({ cls: "governance-row-path", text: item.path });
        // UNTRUSTED agent-authored text. Rendered via renderIntent() (kernel/governance/
        // intent-view.ts), which places it into a text node ONLY (createSpan/text) — never HTML,
        // never a markdown/wikilink/template renderer, however the agent phrased it.
        if (item.intent) {
          renderIntent(main, item.intent, { wrapperCls: "governance-row-intent", full: false });
        }
        const meta = row.createDiv({ cls: "governance-row-meta" });
        meta.createSpan({ text: shortOp(item.op) });
        meta.createSpan({ text: relTime(item.when) });
        row.onclick = () => { this.selected = item.path; this.detailMode = "diff"; void this.rerender(); };
      }
    }
  }

  private async renderDetail(root: HTMLElement, item: PendingItem): Promise<void> {
    // The accept-capable deps are pulled from the module-private WeakMap and captured ONLY by
    // the button click closures below (each closed over this specific `item` row). They are
    // never assigned to `this`, so no app-reachable walk finds an accept/revert callable.
    const deps = viewDeps.get(this)!;
    // "skip" — the one STATELESS descriptor (rotate/deselect only, mutates nothing), so a plain
    // onclick is safe; its label still comes from the declared set.
    const back = root.createEl("button", { cls: "governance-back", text: dispositionById("skip")!.label });
    back.onclick = () => { this.selected = null; void this.rerender(); };

    const title = root.createDiv({ cls: "governance-detail-title" });
    title.createEl("strong", { text: item.title });
    title.createDiv({ cls: "governance-row-path", text: item.path });
    title.createDiv({
      cls: "governance-detail-sub",
      text: `${item.agent} · ${shortOp(item.op)} · ${item.writeCount} write(s) · ${relTime(item.when)}`,
    });
    // #224 side-door rows: name the drifted declared properties (text node — plain data).
    if (item.sideDoor) {
      title.createDiv({
        cls: "governance-detail-sub",
        text: `side-door change to protected propert${(item.protectedKeys?.length ?? 0) === 1 ? "y" : "ies"}: ` +
          `${(item.protectedKeys ?? []).join(", ")} — inert until accepted`,
      });
    }
    // #135 read-only policy badge: the HONORED per-note auto-accept policy, if any.
    const honoredPolicy = deps.honoredAutoAccept(item.path);
    if (honoredPolicy) {
      title.createDiv({ cls: "governance-detail-sub", text: `auto-accept policy (honored): ${honoredPolicy}` });
    }
    // UNTRUSTED agent-authored text — see kernel/governance/intent-view.ts for the text-node-only
    // render path and its behavioral escaping test.
    if (item.intent) {
      renderIntent(title, item.intent, { wrapperCls: "governance-detail-intent", full: true });
    }

    // Navigation: open the live note in the main editor tab. Read-only — opening a file confers
    // no capability renderer-JS lacks (app.workspace can already do it), so a plain onclick is safe
    // here; this is NOT an accept-class handler.
    const nav = root.createDiv({ cls: "governance-nav" });
    const openBtn = nav.createEl("button", { cls: "governance-open", text: "Open in tab" });
    openBtn.onclick = async () => {
      const file = this.app.vault.getAbstractFileByPath(item.path);
      if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
    };
    // Per-note history: opens the display-only history browser pre-filtered to this note.
    // Read-only navigation (no accept capability), so a plain onclick is safe, like "Open in tab".
    const historyBtn = nav.createEl("button", { cls: "governance-open", text: "History" });
    historyBtn.onclick = () => {
      this.paneMode = "history";
      this.historyFilter = item.path;
      void this.rerender();
    };

    // Action buttons — the ONLY accept/revert/request-changes call sites. MEMBERSHIP, ORDER and
    // LABELS come from the declared disposition set (kernel/governance/dispositions.ts — #101,
    // phase 1 of #221): every button below is created from a `pending-item` descriptor, so the
    // pane cannot render a human disposition the table does not declare. The descriptors are
    // pure DATA — the accept-capable callables still arrive ONLY through `deps` (the
    // module-private WeakMap) and are captured ONLY by the addEventListener closures below;
    // wrapping the existing wiring in descriptors adds no reachable callable anywhere.
    const actions = root.createDiv({ cls: "governance-actions" });
    const btnFor = new Map<DispositionId, HTMLButtonElement>();
    for (const d of dispositionsFor("pending-item")) {
      btnFor.set(d.id, actions.createEl("button", { cls: DISPOSITION_BTN_CLS[d.id] ?? "governance-disposition", text: d.label }));
    }
    const acceptBtn = btnFor.get("accept")!;
    const revertBtn = btnFor.get("revert")!;
    const requestBtn = btnFor.get("request-changes")!;
    // Context-aware surfacing (#221/#164): the Accept tooltip says what THIS click will do —
    // for a `proposed` note, that it stamps the accepted family with the configured identity;
    // otherwise that it advances the baseline only. Plain display data; still one click.
    const noteStatus = deps.acceptanceStatus(item.path);
    const identity = deps.acceptedBy();
    acceptBtn.title = acceptEffectFor(noteStatus, identity);
    const setBusy = (busy: boolean): void => {
      for (const b of btnFor.values()) b.disabled = busy;
    };
    // Wired via addEventListener (onclick stays null → unreachable to renderer-JS) and gated on
    // isRealGesture (forged plain-object arg fails instanceof Event; synthesized click has
    // isTrusted false). Only a physical human click reaches deps.accept / deps.revert.
    acceptBtn.addEventListener("click", async (evt) => {
      if (!isRealGesture(evt)) return; // inert on forged arg or synthesized click
      setBusy(true);
      try {
        const res = await acceptThroughGate(this.app, deps, item.path, item.title);
        if (res === null) { setBusy(false); return; } // gate: opened-to-fix or cancelled — nothing happened
        new Notice(
          res.stamped
            ? `governor acceptance: accepted ${item.title} — stamped accepted-by: ${identity}`
            : `governor acceptance: accepted ${item.title}`,
        );
        this.selected = null;
        await this.rerender();
      } catch (e) {
        new Notice(`governor acceptance: accept failed — ${(e as Error).message}`);
        setBusy(false);
      }
    });
    revertBtn.addEventListener("click", async (evt) => {
      if (!isRealGesture(evt)) return; // inert on forged arg or synthesized click
      setBusy(true);
      try {
        await deps.revert(item.path);
        new Notice(`governor acceptance: reverted ${item.title} (previous version quarantined)`);
        this.selected = null;
        await this.rerender();
      } catch (e) {
        new Notice(`governor acceptance: revert failed — ${(e as Error).message}`);
        setBusy(false);
      }
    });
    // request-changes (#101) — HUMAN disposition, gesture-gated exactly like Accept. The click
    // opens the free-text modal (whose confirm button is itself gesture-gated); only then does
    // the state change run: acceptance-status → revising + the [!revision-request] callout below
    // the note's H1 (deps.requestChanges → module-scope performRequestChanges in wiring.ts).
    requestBtn.addEventListener("click", async (evt) => {
      if (!isRealGesture(evt)) return; // inert on forged arg or synthesized click
      const text = await promptRequestChanges(this.app, item.title);
      if (text === null) return; // cancelled — nothing changes
      setBusy(true);
      try {
        await deps.requestChanges(item.path, text);
        new Notice(`governor acceptance: requested changes on ${item.title}`);
        this.selected = null;
        await this.rerender();
      } catch (e) {
        new Notice(`governor acceptance: request-changes failed — ${(e as Error).message}`);
        setBusy(false);
      }
    });

    // Content view — toggle between the unified Diff (default), the Before (baseline) full text and
    // the After (current) full text. All three are read-only renderings; none advances a baseline.
    const baseContent = deps.getBaselineContent(item.path) ?? "";
    let curContent = "";
    try { curContent = await deps.readCurrent(item.path); } catch { curContent = ""; }

    const modeRow = root.createDiv({ cls: "governance-mode" });
    const modes: Array<{ key: "diff" | "before" | "after"; label: string }> = [
      { key: "diff", label: "Diff" },
      { key: "before", label: "Before" },
      { key: "after", label: "After" },
    ];
    for (const m of modes) {
      const b = modeRow.createEl("button", {
        cls: `governance-mode-btn${this.detailMode === m.key ? " is-active" : ""}`,
        text: m.label,
      });
      b.onclick = () => { this.detailMode = m.key; void this.rerender(); };
    }

    if (this.detailMode === "before") {
      root.createEl("pre", { cls: "governance-plain", text: baseContent || "(empty)" });
      return;
    }
    if (this.detailMode === "after") {
      root.createEl("pre", { cls: "governance-plain", text: curContent || "(empty)" });
      return;
    }

    const diff = diffNote(baseContent, curContent);
    const diffEl = root.createDiv({ cls: "governance-diff" });

    const fmChanged = diff.frontmatter.filter((f) => f.status !== "unchanged");
    if (fmChanged.length) {
      diffEl.createDiv({ cls: "governance-diff-section", text: "Frontmatter" });
      const fmTable = diffEl.createDiv({ cls: "governance-fm" });
      for (const f of fmChanged) {
        const rowEl = fmTable.createDiv({ cls: `governance-fm-row fm-${f.status}` });
        rowEl.createSpan({ cls: "governance-fm-key", text: f.key });
        const val = rowEl.createSpan({ cls: "governance-fm-val" });
        if (f.status === "changed") {
          val.createSpan({ cls: "fm-old", text: f.base ?? "" });
          val.createSpan({ cls: "fm-arrow", text: " → " });
          val.createSpan({ cls: "fm-new", text: f.current ?? "" });
        } else if (f.status === "added") {
          val.createSpan({ cls: "fm-new", text: f.current ?? "" });
        } else {
          val.createSpan({ cls: "fm-old", text: f.base ?? "" });
        }
        rowEl.createSpan({ cls: "governance-fm-tag", text: f.status });
      }
    }

    diffEl.createDiv({ cls: "governance-diff-section", text: "Body" });
    const body = diffEl.createDiv({ cls: "governance-body" });
    const bodyChanged = diff.body.some((l) => l.status !== "same");
    if (!bodyChanged) {
      body.createDiv({ cls: "governance-no-changes", text: "No body changes." });
    } else {
      // git-style collapsing: only changed lines + a few lines of surrounding context are
      // shown; long unchanged runs (including leading/trailing) fold into a count marker.
      for (const h of toHunks(diff.body, 3)) {
        if (h.kind === "line") {
          renderDiffLine(body, h.line);
        } else {
          renderCollapsedMarker(body, h);
        }
      }
    }
  }
}

function renderDiffLine(container: HTMLElement, line: DiffLine, before: Node | null = null): void {
  const lineEl = container.createDiv({ cls: `governance-line line-${line.status}` });
  const gutter = line.status === "added" ? "+" : line.status === "removed" ? "−" : " ";
  lineEl.createSpan({ cls: "governance-gutter", text: gutter });
  const textEl = lineEl.createSpan({ cls: "governance-line-text" });
  if (line.words && line.words.length) {
    for (const w of line.words) {
      textEl.createSpan({ cls: w.changed ? "word-changed" : "word-same", text: w.text });
    }
  } else {
    textEl.setText(line.text === "" ? " " : line.text);
  }
  if (before) container.insertBefore(lineEl, before);
}

// Collapsed-run marker — a plain display convenience, not an accept-class control: clicking it
// only expands already-computed, already-visible-in-the-diff lines in place (no vault read/write,
// no baseline advance), so a bare `.onclick` is appropriate here, same as "Open in tab" and the
// mode-toggle buttons above. See the SECURITY note at the top of this file for what IS gated.
function renderCollapsedMarker(container: HTMLElement, h: HunkCollapsed): void {
  const markerEl = container.createDiv({ cls: "governance-collapsed" });
  markerEl.setText(`⋯ ${h.count} unchanged line${h.count === 1 ? "" : "s"} ⋯`);
  markerEl.onclick = () => {
    for (const line of h.lines) renderDiffLine(container, line, markerEl);
    markerEl.remove();
  };
}

function shortOp(op: string): string {
  return op.replace(/^obsidian_/, "");
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
