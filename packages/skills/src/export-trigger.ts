// Export-on-save trigger — the pure half of the skills GUI's save hook, ported
// verbatim from the standalone vault-skills plugin (obsidian/src/export-trigger.ts)
// as part of the GUI fold (#82 residuals). Obsidian-free by construction, so the
// debounce coalescing and the change-relevance predicate are unit-testable
// outside the Obsidian runtime (see tests/skills-gui.test.mjs).
//
// Renaming a skill/agent/policy note makes Obsidian emit a *burst* of metadataCache
// "changed" events — the file rename itself, plus a cascaded `[[wikilink]]` rewrite in
// every child note whose `parent:` pointed at the old name. Exporting on each event would
// validate a half-rewritten tree: a child's `parent` link still resolves to the pre-rename
// basename (now missing), so the transform reports a spurious `unresolved parent` error and
// drops the child from the output. Debouncing collapses the burst into a single export once
// the cache has settled and every cascaded link rewrite is done, so validation always runs
// against the consistent post-rename tree.

import { fieldView, detectKind, type DetectConfig } from "./kernel/exporter.js";

/** A debounced trigger, plus a `cancel()` to drop a pending call (e.g. on plugin unload,
 *  so a queued export never fires against a torn-down plugin). */
export interface Debounced {
  (): void;
  cancel(): void;
}

/** Minimal trailing debounce: `fn` runs once, `waitMs` after the last call. Kept local
 *  (rather than Obsidian's `debounce`) so the coalescing is unit-testable outside the
 *  Obsidian runtime. */
export function debounce(fn: () => void, waitMs: number): Debounced {
  let handle: ReturnType<typeof setTimeout> | null = null;
  const trigger = (() => {
    if (handle !== null) clearTimeout(handle);
    handle = setTimeout(() => {
      handle = null;
      fn();
    }, waitMs);
  }) as Debounced;
  trigger.cancel = () => {
    if (handle !== null) {
      clearTimeout(handle);
      handle = null;
    }
  };
  return trigger;
}

export interface ChangeTriggerDeps {
  /** Whether export-on-save is enabled. */
  isEnabled: () => boolean;
  /** Current detection + field-namespacing config. */
  fields: () => DetectConfig;
  /** Frontmatter of the changed file, or undefined if it has none. */
  getFrontmatter: (file: unknown) => Record<string, unknown> | undefined;
  /** Request an export. Debounced upstream so a rename's burst collapses into one run. */
  requestExport: () => void;
  /** Whether this vault path is transcluded into the compiled output (per the last
   *  export/preview) — such notes are export-relevant even without a skill/agent kind,
   *  since their text is inlined into the artifacts. */
  isSource?: (path: string) => boolean;
}

/** Handle a metadataCache "changed" event: request a (debounced) export when the changed
 *  note is a skill/agent/policy/command — resolved through the configured detection mode
 *  (`type:` field or kind tag), so a bare `type:` on an unrelated note doesn't false-positive
 *  and an ambiguous multi-kind note doesn't trigger churn — or when it is a plain note whose
 *  content is transcluded into the compiled output (`isSource`). */
export function handleNoteChanged(file: unknown, deps: ChangeTriggerDeps): void {
  if (!deps.isEnabled()) return;
  const path = (file as { path?: unknown } | null)?.path;
  if (typeof path === "string" && deps.isSource?.(path)) { deps.requestExport(); return; }
  const fm = deps.getFrontmatter(file);
  if (!fm) return;
  const cfg = deps.fields();
  const { view } = fieldView(fm, cfg);
  const kind = detectKind(view, fm, cfg);
  if (kind && kind !== "ambiguous") deps.requestExport();
}
