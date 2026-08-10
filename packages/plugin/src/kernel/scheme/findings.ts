// findings.ts — the pure conformance findings core. NOT a registered tool:
// this is the rule-pack core a later task wraps as a read-only rail tool.
// Kernel-module rules apply: no "obsidian" import, no I/O, everything pure
// over a supplied `notes: string[]` vault listing.
//
// Every rule's judgment comes from the provider instance — no new hardwired
// semantic constants (Nelson's config-not-hardwired ruling). This module
// only sequences four provider-delegated checks and sorts the result.

import type { SchemeFinding } from "./provider.js";
import type { SchemeInstance } from "./registry.js";

function basenameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function folderOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

/**
 * Conformance findings over `notes`, per `instance`'s provider. Four rule
 * classes, each delegating its judgment to the provider:
 *
 *   - malformed_name: `provider.validateName(basename)` per note — findings
 *     from a note in isolation, no vault context needed. Runs first because
 *     it decides whether a note's addressOf-null-ness is a BROKEN address
 *     attempt (malformed_name) or no attempt at all (unaddressed, below) —
 *     the two are mutually exclusive per note: a note already flagged
 *     malformed_name is not also flagged unaddressed, since the provider's
 *     own numeric-looking-token heuristic (not this module) is what decides
 *     "attempted" vs "absent".
 *   - unaddressed: `scopeOf(path)` non-null, `addressOf(path)` null, and not
 *     already malformed_name. Scratch/index conventions are NOT
 *     special-cased in v1 — the rail's ratchet baselines them.
 *   - duplicate_address: two+ notes whose `format(addressOf(path))` match —
 *     one finding per EXTRA path, in listing order; the detail names the
 *     FIRST claimant (recorded once, never overwritten), which is itself
 *     never flagged.
 *   - misfiled: an addressed note whose actual folder differs from
 *     `expectedFolder(addr, notes)`, when that is derivable (non-null).
 *
 * Output is sorted by path, then by code, for a deterministic listing.
 */
export function schemeFindings(instance: SchemeInstance, notes: string[]): SchemeFinding[] {
  const provider = instance.provider;
  const findings: SchemeFinding[] = [];
  const firstClaimant = new Map<string, string>(); // formatted address -> first path to claim it

  for (const path of notes) {
    const malformed = provider.validateName(basenameOf(path)).map((f) => ({ ...f, path }));
    findings.push(...malformed);

    const addr = provider.addressOf(path);

    if (addr === null) {
      if (malformed.length === 0) {
        const scope = provider.scopeOf(path);
        if (scope !== null) {
          findings.push({
            code: "unaddressed",
            path,
            detail: `lives in scope ${scope.kind} '${scope.token}' but has no recognizable address`,
          });
        }
      }
      continue;
    }

    const addrStr = provider.format(addr);
    const first = firstClaimant.get(addrStr);
    if (first === undefined) {
      firstClaimant.set(addrStr, path);
    } else {
      findings.push({
        code: "duplicate_address",
        path,
        detail: `address '${addrStr}' is already claimed by '${first}'`,
      });
    }

    const expected = provider.expectedFolder(addr, notes);
    const actual = folderOf(path);
    if (expected !== null && expected !== actual) {
      findings.push({
        code: "misfiled",
        path,
        detail: `expected folder '${expected}', found in '${actual}'`,
      });
    }
  }

  findings.sort((a, b) => (a.path === b.path ? a.code.localeCompare(b.code) : a.path.localeCompare(b.path)));
  return findings;
}
