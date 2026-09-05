/**
 * A runtime stand-in for the `obsidian` module — the minimum this package
 * needs, which is far less than the host's equivalent.
 *
 * The real package is TYPES ONLY (`"main": ""`), so any source file importing a
 * live class from it cannot be loaded in node at all. That is why everything
 * here except `src/obsidian-source.ts` (and the settings tab, which is pure
 * rendering) is obsidian-free. The move path is the one exception worth
 * reaching: it is a single `instanceof TFile` away from being pure logic, and
 * the property under test — a move renames through `fileManager.renameFile`,
 * never `vault.rename` — is a property of the REAL adapter, not of a
 * re-implementation.
 *
 * `installObsidianStub()` registers a synchronous resolve hook mapping the
 * "obsidian" specifier at this file, so a test can `await import()` the real
 * module under test afterwards. It is scoped to the process that calls it — no
 * other test file is affected. (Not a *.test.mjs file — the glob skips it.)
 */

import { registerHooks } from "node:module";

/** Minimal TFile: a path plus the `stat` the adapter reads. */
export class TFile {
  constructor(path, mtime = 1) {
    this.path = path;
    this.stat = { mtime, ctime: mtime, size: 0 };
    const name = path.split("/").pop() ?? path;
    this.name = name;
    this.basename = name.replace(/\.[^.]+$/, "");
    this.extension = name.includes(".") ? name.split(".").pop() : "";
  }
}

export class TFolder {
  constructor(path, children = []) {
    this.path = path;
    this.children = children;
  }
}

export class TAbstractFile {}

/** Only needed so `class TriageSettingTab extends PluginSettingTab` evaluates
 *  if anything ever pulls the tab in transitively. */
export class App {}
export class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
  }
}
export class Setting {
  constructor() {}
}
export class Plugin {}
export class Notice {
  constructor() {}
}

let installed = false;

/** Point the "obsidian" specifier at this module for every subsequent import. */
export function installObsidianStub() {
  if (installed) return;
  installed = true;
  const url = import.meta.url;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "obsidian") return { url, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
}
