// The declared NON-MCP SURFACE INVENTORY — Gate 0, WP0 (second half).
//
// MCP is one door onto Governor. It is not the only one, and it is not the
// important one: the accept gesture has NO MCP surface by design, so an
// inventory that stopped at the bridge would omit precisely the operations
// that create standing.
//
// Three kinds of door are declared here:
//
//   ui          an Obsidian command, a review-pane control, a settings button
//               — something a human clicks
//   automation  a timer, a vault or metadata event subscription, a
//               layout-ready hook — work that starts with no caller at all
//   internal    a Governor-to-Governor call
//
// The AUTHORITY rows are the point of the exercise. They are the only actions
// in this repository declared `governorOnly` with the `authority` change
// class, and `registry.ts` refuses at build time to bind any of them to an
// `mcp` or `external` surface. That is the static counterpart to the two
// runtime controls the pane already enforces: every capability-bearing control
// is wired with `addEventListener` rather than `.onclick =` (so the function is
// not a reachable property), and every handler calls `isRealGesture(evt)`,
// which requires a genuine `Event` with `isTrusted === true`.
//
// Two structural facts this inventory depends on are asserted by its test
// rather than assumed, because both are load-bearing and neither was checked
// by anything before:
//
//   • `src/governance/` registers ZERO Obsidian commands. Every command is
//     agent-invocable through `obsidian_run_command`'s `executeCommandById`,
//     so an accept command would be a self-approval primitive one
//     prompt-injection away.
//   • none of the seven accept-perimeter functions is exported. Export is what
//     would make one reachable from a plugin instance, a view instance, or any
//     other object an agent-facing path can obtain.

import type { ActionDefinition, Distribution, SurfaceKind } from "./action.js";
import { compatibilityAction } from "./compatibility.js";
import type { SurfaceBinding } from "./surface-binding.js";

// ── the accept perimeter ─────────────────────────────────────────────────────

/**
 * The module-scope functions in `governance/wiring.ts` that can change
 * authority state. Named here so the test can assert they still exist and are
 * still unexported — an inventory that describes deleted code is worse than
 * none, and an exported one is a hole.
 */
export const ACCEPT_PERIMETER_FUNCTIONS = [
  "performAccept",
  "performRevert",
  "performAdopt",
  "setClassEnabled",
  "performRequestChanges",
  "performWithdraw",
  "reconcile",
] as const;

export interface AuthorityRow {
  /** Surface identity — where the human gesture or automation lives. */
  id: string;
  kind: Extract<SurfaceKind, "ui" | "automation" | "internal">;
  /** Registered action id. */
  action: string;
  title: string;
  postcondition: string;
  /** The `governance/wiring.ts` function this surface ultimately calls. */
  implementation: (typeof ACCEPT_PERIMETER_FUNCTIONS)[number];
  paths?: string[];
  /** Change classes beyond `authority`, when the act also alters content. */
  alsoChanges?: Array<"content" | "structural">;
  /** How reachability is restricted, in one phrase. */
  reachability: string;
}

export const AUTHORITY_SURFACES: AuthorityRow[] = [
  {
    id: "governance.pane.accept",
    kind: "ui",
    action: "governance.accept",
    title: "Accept a proposal",
    postcondition: "Stamp the accepted family on one note and advance its baseline to the exact reviewed content.",
    implementation: "performAccept",
    paths: ["path"],
    reachability: "pane detail-view and Proposed-section buttons, wired with addEventListener + isRealGesture",
  },
  {
    id: "governance.context-menu.accept",
    kind: "ui",
    action: "governance.accept",
    title: "Accept a proposal from the file menu",
    postcondition: "Open a confirmation modal whose own confirm button performs the accept.",
    implementation: "performAccept",
    paths: ["path"],
    // Obsidian renders file-menu items natively and delivers no trusted Event
    // to the menu callback, so `isRealGesture` there was permanently inert and
    // was removed. The menu item can therefore only OPEN a modal; the accept
    // happens from that modal's own click, which restores both gesture layers.
    // Worst case for a forged menu trigger is that a dialog appears.
    reachability: "menu item opens a ConfirmModal only; the write happens from the modal's gesture-gated confirm",
  },
  {
    id: "governance.pane.revert",
    kind: "ui",
    action: "governance.revert",
    title: "Revert to the admitted baseline",
    postcondition: "Restore one note's prior admitted content, creating new history rather than erasing the admission.",
    implementation: "performRevert",
    paths: ["path"],
    alsoChanges: ["content"],
    reachability: "pane detail-view button, addEventListener + isRealGesture",
  },
  {
    id: "governance.pane.adopt-baseline",
    kind: "ui",
    action: "governance.adopt-baseline",
    title: "Adopt current content as the baseline",
    postcondition: "Advance every pending note's baseline to its current content in one act.",
    implementation: "performAdopt",
    reachability: "pane button, addEventListener + isRealGesture + a confirm step",
  },
  {
    id: "governance.settings.adopt-baseline",
    kind: "ui",
    action: "governance.adopt-baseline",
    title: "Adopt current content as the baseline (settings tab)",
    postcondition: "The same mass advance, reached from the settings tab.",
    implementation: "performAdopt",
    reachability: "settings-tab button sharing the pane's wireAdoptButton, same two gesture layers",
  },
  {
    id: "governance.pane.auto-accept-class",
    kind: "ui",
    action: "governance.set-auto-accept-class",
    title: "Enable or disable an auto-accept class",
    postcondition: "Change which mechanical change classes Governor may admit without a further gesture.",
    implementation: "setClassEnabled",
    reachability: "pane allowlist checkboxes, addEventListener + isRealGesture",
  },
  {
    id: "governance.settings.auto-accept-class",
    kind: "ui",
    action: "governance.set-auto-accept-class",
    title: "Enable or disable an auto-accept class (settings tab)",
    postcondition: "The same policy change, reached from the settings tab.",
    implementation: "setClassEnabled",
    reachability: "settings-tab checkboxes sharing the pane's renderAllowlist",
  },
  {
    id: "governance.pane.request-changes",
    kind: "ui",
    action: "governance.request-changes",
    title: "Request changes on a proposal",
    postcondition: "Move a proposal to revising and record the human's feedback, conferring no standing.",
    implementation: "performRequestChanges",
    paths: ["path"],
    alsoChanges: ["content"],
    reachability: "pane button and modal, addEventListener + isRealGesture",
  },
  {
    id: "governance.pane.withdraw",
    kind: "ui",
    action: "governance.withdraw",
    title: "Withdraw a proposal",
    postcondition: "Remove a proposal from review without accepting it.",
    implementation: "performWithdraw",
    paths: ["path"],
    alsoChanges: ["content"],
    reachability: "pane button, addEventListener + isRealGesture",
  },
  {
    // The one baseline advance with NO click anywhere. It is gated instead on
    // a POSITIVE signal — `recentGenuineHumanInput`, derived from real
    // `beforeinput`/`paste` DOM events — which is exactly the
    // "local-human-observed" origin class: observed, not cryptographically
    // proven, and trusted within the documented same-user threat model.
    id: "governance.automation.reconcile-observed-edit",
    kind: "automation",
    action: "governance.reconcile-observed-human-edit",
    title: "Reconcile an observed human edit",
    postcondition:
      "Advance a note's baseline silently when the edit is attributable to recent genuine human input in the editor.",
    implementation: "reconcile",
    paths: ["path"],
    reachability: "vault 'modify' event, debounced; gated on recentGenuineHumanInput rather than on any gesture",
  },
];

/** One native authority action per distinct `action` id above. */
function authorityAction(
  id: string,
  title: string,
  postcondition: string,
  paths: string[],
  alsoChanges: Array<"content" | "structural"> = []
): ActionDefinition {
  return {
    id,
    version: 1,
    title,
    postcondition,
    owner: "acceptance",
    // Never public in the MCP sense — there is no client-facing door at all.
    // `private` here means "operator/human surface", not "operator pack".
    distribution: "private",
    modes: ["authority"],
    // Canonical order: content before authority.
    changeClasses: [...alsoChanges, "authority"],
    // Deliberately the weakest capture, and deliberately NOT `replayable`.
    //
    // The target contract says authority inputs are replayable — but no
    // observation substrate exists yet, so declaring `replayable` here would
    // assert a guarantee no code provides. Raised in WP2, when there is
    // something to raise it to.
    observations: { defaultCapture: "ephemeral", supportsProposal: false },
    effects: { direct: ["standing", "accepted-frontmatter", "baseline"], discovered: "none" },
    authority: { governorOnly: true, automaticAdmission: "never" },
    scope: {
      argumentKeys: paths,
      resolvesAddresses: false,
      enumeration: paths.length > 0 ? "not-applicable" : "filter-before-read",
      whenScoped: "available",
    },
    // The acceptance log records these; that is observable today.
    retention: { operation: "durable" },
    inputs: paths,
    // Authored against this registry rather than derived from a registration —
    // there IS no registration metadata to derive from, because the accept
    // path is deliberately a set of module-scope closures with no tool, no
    // command and no exported symbol.
    //
    // `native` means the CONTRACT was authored. It does NOT mean the action is
    // routed through the operation executor — nothing is, yet. WP1 does that.
    native: true,
  };
}

const AUTHORITY_ACTIONS: ActionDefinition[] = [
  authorityAction(
    "governance.accept",
    "Accept a proposal",
    "Stamp the accepted family on one note and advance its baseline to the exact reviewed content.",
    ["path"]
  ),
  authorityAction(
    "governance.revert",
    "Revert to the admitted baseline",
    "Restore one note's prior admitted content, creating new history rather than erasing the admission.",
    ["path"],
    ["content"]
  ),
  authorityAction(
    "governance.adopt-baseline",
    "Adopt current content as the baseline",
    "Advance every pending note's baseline to its current content in one act.",
    []
  ),
  authorityAction(
    "governance.set-auto-accept-class",
    "Set an auto-accept class",
    "Change which mechanical change classes Governor may admit without a further gesture.",
    []
  ),
  authorityAction(
    "governance.request-changes",
    "Request changes on a proposal",
    "Move a proposal to revising and record the human's feedback, conferring no standing.",
    ["path"],
    ["content"]
  ),
  authorityAction(
    "governance.withdraw",
    "Withdraw a proposal",
    "Remove a proposal from review without accepting it.",
    ["path"],
    ["content"]
  ),
  authorityAction(
    "governance.reconcile-observed-human-edit",
    "Reconcile an observed human edit",
    "Advance a note's baseline silently when the edit is attributable to recent genuine human input in the editor.",
    ["path"]
  ),
];

// ── Obsidian commands ────────────────────────────────────────────────────────

export interface CommandRow {
  /** The command id as registered. Obsidian namespaces it as `governor:<id>`. */
  id: string;
  title: string;
  postcondition: string;
  owner: string;
  distribution: Distribution;
  readOnly: boolean;
  /** `governor-only` is refused by this inventory's test: a command is
   * agent-invocable through `obsidian_run_command`, so it may never bind an
   * authority action. */
  authority?: "governor-only";
  note?: string;
}

export const COMMAND_SURFACES: CommandRow[] = [
  {
    id: "connect-claude-code",
    title: "Connect to Claude Code",
    postcondition: "Register this vault's bridge with the local Claude Code CLI.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
    note: "spawns the `claude` binary; never writes ~/.claude.json directly",
  },
  {
    id: "run-tool",
    title: "Run tool…",
    postcondition: "Invoke any captured tool through the same guarded path a Code Mode connection uses.",
    owner: "core",
    distribution: "private",
    readOnly: false,
    // Not a bypass — it dispatches through the identical guard/queue/journal
    // path — but it IS a distinct door, and one that can reach any mutating
    // tool from inside Obsidian. Gated live on `settings.devToolRunner`.
    note: "dev tool-runner, gated on settings.devToolRunner via checkCallback",
  },
  {
    id: "show-diagnostics",
    title: "Show diagnostics",
    postcondition: "Display bridge, vault and integration state in a modal.",
    owner: "core",
    distribution: "public-default",
    readOnly: true,
  },
  {
    id: "scheme-inbox-open",
    title: "Scheme: open JD inboxes",
    postcondition: "Activate the scheme inbox view.",
    owner: "scheme",
    distribution: "public-optional",
    readOnly: true,
  },
  {
    id: "scheme-drift-open",
    title: "Scheme: open JD drift",
    postcondition: "Activate the scheme drift view.",
    owner: "scheme",
    distribution: "public-optional",
    readOnly: true,
  },
  {
    id: "skills-export",
    title: "Skills: export skills & agents to Claude Code",
    postcondition: "Write the compiled skills and agents to the configured output directory, outside the vault.",
    owner: "skills",
    distribution: "private",
    readOnly: false,
  },
  {
    id: "skills-validate",
    title: "Skills: validate tree",
    postcondition: "Report compile errors, warnings and preload counts without writing.",
    owner: "skills",
    distribution: "private",
    readOnly: true,
  },
  {
    id: "skills-tree",
    title: "Skills: show tree",
    postcondition: "Display the agent and skill hierarchy.",
    owner: "skills",
    distribution: "private",
    readOnly: true,
  },
  {
    id: "skills-mark",
    title: "Skills: mark note as skill / agent / policy / command",
    postcondition: "Set the active note's skills frontmatter, through the accept-forbidden guard.",
    owner: "skills",
    distribution: "private",
    readOnly: false,
  },
  {
    id: "skills-release",
    title: "Skills: export release to repo",
    postcondition: "Export the compiled corpus into a repository checkout and stamp a version.",
    owner: "skills",
    distribution: "private",
    readOnly: false,
  },
  {
    id: "skills-preview",
    title: "Skills: preview compiled output",
    postcondition: "Activate the skills preview view.",
    owner: "skills",
    distribution: "private",
    readOnly: true,
  },
];

// ── automation ───────────────────────────────────────────────────────────────

export interface AutomationRow {
  id: string;
  /** Repo-relative file, checked against the scan. */
  file: string;
  title: string;
  postcondition: string;
  owner: string;
  /** True when this automation can change authority state with no gesture. */
  touchesAuthority: boolean;
}

export const AUTOMATION_SURFACES: AutomationRow[] = [
  {
    id: "automation.governance.events",
    file: "src/governance/wiring.ts",
    title: "Governance event subscriptions and journal poll",
    postcondition:
      "Keep the review queue current from vault modify/rename/delete events, a 2.5s journal poll and a layout-ready paint.",
    owner: "acceptance",
    // The poll drives sweepAutoAccept -> maybeAutoAccept, which CAN advance a
    // baseline for an allowlisted mechanical class; the modify handler drives
    // reconcile, which can advance one silently. Both are authority-bearing.
    touchesAuthority: true,
  },
  {
    id: "automation.core.uid-index",
    file: "src/main.ts",
    title: "Stable identity index maintenance",
    postcondition: "Keep the uid index fresh from metadata-cache and vault events; gated on the socket being enabled.",
    owner: "core",
    touchesAuthority: false,
  },
  {
    id: "automation.scheme.inbox-refresh",
    file: "src/scheme/inbox-pane.ts",
    title: "Scheme inbox refresh",
    postcondition: "Rescan the inbox view when notes are created, deleted or renamed.",
    owner: "scheme",
    touchesAuthority: false,
  },
  {
    id: "automation.skills.preview-refresh",
    file: "src/skills/pane.ts",
    title: "Skills preview refresh",
    postcondition: "Recompile the preview when its sources change.",
    owner: "skills",
    touchesAuthority: false,
  },
  {
    id: "automation.skills.export-on-save",
    file: "src/skills/wiring.ts",
    title: "Skills export on save",
    postcondition: "Re-export the compiled corpus after a debounce when the opt-in setting is on.",
    owner: "skills",
    touchesAuthority: false,
  },
];

// ── projections ──────────────────────────────────────────────────────────────

const COMMAND_ACTION_PREFIX = "compat.command.";
const AUTOMATION_ACTION_PREFIX = "compat.automation.";

export function commandActionId(id: string): string {
  return `${COMMAND_ACTION_PREFIX}${id}`;
}

/** Every non-MCP action: derived ones for commands and automation, authored
 * ones for the authority perimeter. */
export function nonMcpActions(): ActionDefinition[] {
  const commands = COMMAND_SURFACES.map((row) =>
    compatibilityAction({
      surface: `command.${row.id}`,
      postcondition: row.postcondition,
      owner: row.owner,
      distribution: row.distribution,
      readOnly: row.readOnly,
      reason: `pre-registry Obsidian command; reachable from the palette and from obsidian_run_command${row.note ? ` (${row.note})` : ""}`,
    })
  );
  const automation = AUTOMATION_SURFACES.map((row) =>
    compatibilityAction({
      surface: `automation.${row.id}`,
      postcondition: row.postcondition,
      owner: row.owner,
      // Automation has no caller, so nothing about it is read-only in the
      // sense the guard means; it is declared mutating so it can never be
      // mistaken for a free operation.
      readOnly: false,
      distribution: "private",
      reason: "pre-registry automation entry point; runs with no caller",
    })
  );
  return [...commands, ...automation, ...AUTHORITY_ACTIONS];
}

export function nonMcpBindings(): SurfaceBinding[] {
  const commands: SurfaceBinding[] = COMMAND_SURFACES.map((row) => ({
    kind: "ui",
    id: `command:${row.id}`,
    action: `compat.command.${row.id}`,
    actionVersion: 1,
    ...(row.note ? { note: row.note } : {}),
  }));
  const automation: SurfaceBinding[] = AUTOMATION_SURFACES.map((row) => ({
    kind: "automation",
    id: row.id,
    action: `compat.automation.${row.id}`,
    actionVersion: 1,
    source: row.file,
  }));
  const authority: SurfaceBinding[] = AUTHORITY_SURFACES.map((row) => ({
    kind: row.kind,
    id: row.id,
    action: row.action,
    actionVersion: 1,
    source: "src/governance/wiring.ts",
    note: row.reachability,
  }));
  return [...commands, ...automation, ...authority];
}
