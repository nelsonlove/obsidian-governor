/**
 * A runtime stand-in for the `obsidian` module.
 *
 * The real package is TYPES ONLY (`"main": ""`), so any source file that
 * imports a live class from it — `TFile`, `TFolder`, `getAllTags` — cannot be
 * loaded in node at all, which is why the plugin keeps its testable logic in
 * obsidian-free modules. The move path is the exception worth reaching: it is
 * one `instanceof TFile` away from being pure logic, and the property under
 * test (a move renames through `fileManager.renameFile`, never `vault.rename`)
 * is precisely a property of the real handler, not of a re-implementation.
 *
 * `installObsidianStub()` registers a synchronous resolve hook mapping the
 * "obsidian" specifier at this file, so a test can `await import()` the real
 * module under test afterwards. It is scoped to the process that calls it — no
 * other test file is affected, and the npm test script is unchanged.
 */

import { registerHooks } from "node:module";

/** Minimal TFile: a path plus the `stat.mtime` the kernel's probe reads. */
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

export function getAllTags() {
  return [];
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
