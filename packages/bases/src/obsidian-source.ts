// obsidian-source.ts — the vault-bases satellite's live adapter: a separate
// file so tools.ts stays obsidian-free and headless-testable; only main.ts
// imports this. (It was `mcp/obsidian-bases-source.ts` in the host, where only
// server.ts imported it; the pattern and the discipline are unchanged. The
// triage and cross-session satellites carry the same split.)
//
// ONE THING CHANGED AT THE EXTRACTION, and it is worth knowing: `available()`
// is no longer evaluated per connection-build. main.ts calls it once per
// `republish()` — at plugin load and on every settings write — so a user who
// upgrades Obsidian to 1.10+ WITHOUT reloading this plugin keeps an empty tool
// surface until a reload. Absent, not broken, exactly as before; just latched
// at a coarser grain. See README.md.
//
// ── The capture mechanism, and why it looks like this (live findings) ───────
//
// The public Bases API (obsidian.d.ts ≥1.10: BasesEntry, BasesQueryResult,
// BasesView, registerBasesView) pushes evaluated rows ONLY into a rendered
// view. Three findings from live investigation (Obsidian 1.13, the real
// vault, 2026-08-19) shaped this adapter — all three are documented on issue
// #243's PR:
//
//   1. A DETACHED leaf (`new WorkspaceLeaf(app)`, never inserted into the
//      workspace layout) loads the REAL bases container view — it is exempt
//      from the deferred-view machinery, which only wraps leaves the
//      workspace itself lays out.
//   2. But the engine's scan PAUSES until the view's container element is
//      "shown": QueryController.runQuery awaits `viewContainerEl.isShown()`
//      (⇔ `!!offsetParent`) between batches. A leaf with no DOM home
//      therefore never produces data. So the adapter parents the leaf's
//      containerEl under a fixed-position, opacity:0, pointer-events:none,
//      z-index:-1000 host div on document.body: layout happens (offsetParent
//      is real), paint does not — nothing is visible, nothing is focusable,
//      and the human's workspace is untouched (no tab, no flash, no focus
//      steal; the leaf never enters the workspace tree at all).
//   3. The engine instantiates the view REGISTERED FOR THE DECLARED VIEW'S
//      TYPE (`plugin.getRegistration(viewConfig.type)`): a view type of ours
//      registered via `registerBasesView` can never be selected for a base
//      authored with `type: table` views. So the issue's original
//      register-a-capture-view sketch is unimplementable for real bases, and
//      this adapter instead reads the PUBLIC `BasesView.data`
//      (BasesQueryResult) off the view the engine itself created — polling
//      for its arrival rather than subclassing anything. `data` is assigned
//      only by a COMPLETED evaluation pass (the engine skips pushes while its
//      initial scan runs), so first-data == full, filtered, formula-evaluated
//      result set — verified live: 601 rows for a view whose filter matches
//      exactly 601 notes.
//
// The one non-public surface consumed: the bases container view's
// `.controller.view` path to the current BasesView instance (the container
// class itself is not in obsidian.d.ts). Every hop is feature-checked and a
// missing shape degrades to a timeout refusal — never a crash, never a hang.
//
// Timing: the scan runs on a batched scheduler that Electron throttles when
// the window is hidden — measured 5.7s foreground-ish vs 64s hidden on a
// 1.9k-note vault. Hence the module's generous default queryTimeoutMs and the
// typed, retryable `base_timeout` refusal.
//
// Cleanup is absolute: `captureWithCleanup` detaches the leaf and removes the
// host div in a finally — success, failure, and timeout alike — and the
// poll loop watches a `cancelled` flag so a timed-out capture stops polling
// instead of spinning forever.

import { NullValue, Plugin, TFile, WorkspaceLeaf, parseYaml, type App } from "obsidian";
import {
  captureWithCleanup,
  normalizePropertyId,
  type CapturedRow,
} from "./kernel/index.js";
import type { BasesSource, CaptureResult } from "./tools.js";

/** Invisible-but-"shown": fixed-position so layout is real (offsetParent
 * non-null — the engine's isShown gate), opacity:0 so nothing paints,
 * pointer-events:none + negative z-index so nothing is interactive. */
const HIDDEN_HOST_STYLE =
  "position:fixed;top:0;left:0;width:800px;height:600px;opacity:0;pointer-events:none;z-index:-1000;overflow:hidden;";

const POLL_MS = 100;

/** The duck-typed shapes the capture path reads off the live objects. */
interface BasesEntryLike {
  file?: { path?: string };
  getValue(propertyId: string): { toString(): string } | null;
}
interface BasesQueryResultLike {
  data?: BasesEntryLike[];
  properties?: string[];
}
interface BasesViewLike {
  data?: BasesQueryResultLike;
}

export function obsidianBasesSource(app: App): BasesSource {
  return {
    available: () => {
      // The canonical 1.10+ marker per #243: the public registration hook on
      // the Plugin prototype (probed, never called — see finding 3 above for
      // why registering a capture view type would be dead surface), plus the
      // leaf class the capture constructs.
      if (typeof (Plugin.prototype as unknown as { registerBasesView?: unknown }).registerBasesView !== "function") return false;
      if (typeof WorkspaceLeaf !== "function") return false;
      // The API marker survives the user toggling the Bases CORE PLUGIN off,
      // but the "bases" view type does not — and without it every capture
      // would spin a hidden leaf into a 30s timeout that misdiagnoses a
      // permanent condition as transient (independent-review finding). Probe
      // the extension→view-type registry (undocumented, hence duck-typed and
      // FAIL-OPEN on an unknown registry shape: the registerBasesView probe
      // above already established the API generation).
      const reg = (app as { viewRegistry?: { getTypeByExtension?: (ext: string) => string | undefined } }).viewRegistry;
      if (typeof reg?.getTypeByExtension !== "function") return true;
      return reg.getTypeByExtension("base") === "bases";
    },

    listBasePaths: () =>
      app.vault
        .getFiles()
        .filter((f) => f.extension === "base")
        .map((f) => f.path),

    readBaseConfig: async (path) => {
      const f = app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) return { exists: false };
      const text = await app.vault.cachedRead(f);
      try {
        return { exists: true, config: parseYaml(text) ?? {} };
      } catch (e) {
        return { exists: true, parseError: String(e instanceof Error ? e.message : e) };
      }
    },

    capture: (path, viewName, columns, timeoutMs) => {
      let leaf: WorkspaceLeaf | null = null;
      let host: HTMLElement | null = null;
      let cancelled = false;
      return captureWithCleanup<CaptureResult>(
        {
          start: async () => {
            const file = app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) throw new Error(`no such base: ${path}`);
            // A detached leaf: real to the view system, invisible to the
            // workspace (finding 1). The constructor is not in the public
            // typings, hence the cast — its runtime shape is verified by the
            // live smoke, and a mismatch surfaces as a typed timeout, not a
            // hang (captureWithCleanup's deadline still fires).
            leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)(app);
            host = document.body.createDiv();
            host.setAttribute("style", HIDDEN_HOST_STYLE);
            // `containerEl` is real at runtime but not in the public leaf
            // typings — same duck-typed hop as `.controller.view` below.
            host.appendChild((leaf as unknown as { containerEl: HTMLElement }).containerEl);
            await leaf.setViewState({
              type: "bases",
              state: { file: path, ...(viewName !== undefined ? { viewName } : {}) },
            });
            // Await the engine's first COMPLETED push (finding 3): the
            // current BasesView's public `data` is assigned only by a full
            // evaluation pass.
            const view = await new Promise<BasesViewLike>((resolve, reject) => {
              const poll = () => {
                if (cancelled) {
                  reject(new Error("capture cancelled"));
                  return;
                }
                const v = (leaf?.view as { controller?: { view?: BasesViewLike } } | undefined)?.controller?.view;
                if (v?.data?.data) {
                  resolve(v);
                  return;
                }
                setTimeout(poll, POLL_MS);
              };
              poll();
            });
            const result = view.data as BasesQueryResultLike;
            const effectiveColumns =
              columns ?? (result.properties ?? []).map(normalizePropertyId);
            // Materialize EAGERLY: BasesEntry objects are recreated by the
            // engine and die with the leaf — nothing live may escape the
            // cleanup boundary.
            const rows: CapturedRow[] = (result.data ?? []).map((entry) => {
              const values: Record<string, string | null> = {};
              for (const col of effectiveColumns) {
                let v: { toString(): string } | null = null;
                try {
                  v = entry.getValue(col);
                } catch {
                  v = null;
                }
                // A missing value arrives as the engine's NullValue OBJECT
                // (whose toString() is the string "null") — fold it to a real
                // JSON null so absent and the literal text "null" stay
                // distinguishable in the row.
                values[col] = v === null || v === undefined || v instanceof NullValue ? null : String(v);
              }
              return { path: entry.file?.path ?? "", values };
            });
            return { columns: effectiveColumns, rows };
          },
          cleanup: () => {
            cancelled = true;
            try {
              leaf?.detach();
            } catch {
              // a leaf that failed to construct has nothing to detach
            }
            try {
              host?.remove();
            } catch {
              // ditto
            }
          },
        },
        timeoutMs,
      );
    },
  };
}
