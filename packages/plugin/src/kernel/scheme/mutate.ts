// mutate.ts — pure planning logic for three mutations: assign, refile, renumber.
// These functions plan changes without executing them. Each returns a discriminated
// {ok: true, result} | {ok: false, error} union — never throws.
//
// Kernel purity rule: imports ONLY from ./provider.js (types: ScopeProvider, Address,
// Scope). Every operation goes through the provider parameter; the module must work
// for ANY ScopeProvider implementation, not just Johnny Decimal.

import type { Address, Scope, ScopeProvider } from "./provider.js";

export interface MoveStep {
  from: string;
  to: string;
}

export interface AssignResult {
  address: string;
  step: MoveStep;
}
export type AssignOutcome = { ok: true; result: AssignResult } | { ok: false; error: string };

export interface RefileResult {
  address: string;
  step: MoveStep | null;
  alreadyCorrect: boolean;
}
export type RefileOutcome = { ok: true; result: RefileResult } | { ok: false; error: string };

export type OnOccupied = "auto" | "manual" | "fail";
export interface RenumberResult {
  steps: MoveStep[];
  displaced: string | null;
}
export type RenumberOutcome = { ok: true; result: RenumberResult } | { ok: false; error: string };

/**
 * Compute the expected full path for a note with the given address and title.
 */
function computePath(
  provider: ScopeProvider,
  addr: Address,
  title: string,
  notes: string[]
): string | null {
  const folder = provider.expectedFolder(addr, notes);
  if (folder === null) return null;
  const formatted = provider.format(addr);
  return `${folder}/${formatted} ${title}.md`;
}

/**
 * planAssign — compute the next free address in a scope and a move into it.
 *
 * - Calls `provider.nextFree(scope, notes)` to find the next free address
 * - If null, checks allocatable() to distinguish "never allocatable" from "exhausted"
 * - Computes expected folder and filename
 * - Returns a single move step from the unfiled note to its new location
 */
export function planAssign(
  provider: ScopeProvider,
  scope: Scope,
  notePath: string,
  notes: string[]
): AssignOutcome {
  const next = provider.nextFree(scope, notes);
  if (next === null) {
    const alloc = provider.allocatable(scope);
    if (!alloc.allocatable) {
      return {
        ok: false,
        error: "scope is not allocatable",
      };
    }
    return {
      ok: false,
      error: "scope exhausted or not allocatable",
    };
  }

  const title = provider.titleOf(notePath);
  const to = computePath(provider, next, title, notes);
  if (to === null) {
    return {
      ok: false,
      error: "cannot determine the expected folder for the newly-assigned address",
    };
  }

  const address = provider.format(next);
  return {
    ok: true,
    result: {
      address,
      step: {
        from: notePath,
        to,
      },
    },
  };
}

/**
 * planRefile — move a note to its expected folder based on its address.
 *
 * - Extracts the address from the note's filename
 * - If no address, returns error
 * - Computes expected folder and filename
 * - If already correct, returns {step: null, alreadyCorrect: true}
 * - Otherwise returns a single move step
 */
export function planRefile(
  provider: ScopeProvider,
  notePath: string,
  notes: string[]
): RefileOutcome {
  const addr = provider.addressOf(notePath);
  if (addr === null) {
    return {
      ok: false,
      error: "note has no address to refile against",
    };
  }

  const title = provider.titleOf(notePath);
  const expectedPath = computePath(provider, addr, title, notes);
  if (expectedPath === null) {
    return {
      ok: false,
      error: "cannot determine the expected folder for the note's address",
    };
  }

  if (notePath === expectedPath) {
    return {
      ok: true,
      result: {
        address: provider.format(addr),
        step: null,
        alreadyCorrect: true,
      },
    };
  }

  return {
    ok: true,
    result: {
      address: provider.format(addr),
      step: {
        from: notePath,
        to: expectedPath,
      },
      alreadyCorrect: false,
    },
  };
}

/**
 * planRenumber — move a note to a target address, handling occupant displacement.
 *
 * - Checks if target is occupied via `provider.occupantOf(to, notes)`
 * - If no occupant: single step moving source to target
 * - If occupied:
 *   - onOccupied === "fail": error
 *   - onOccupied === "manual": requires displaceTo, checks it's free, two-step with occupant first
 *   - onOccupied === "auto": computes next free in occupant's own scope, two-step with occupant first
 * - Always returns occupant-first ordering in steps
 */
export function planRenumber(
  provider: ScopeProvider,
  notePath: string,
  to: Address,
  notes: string[],
  onOccupied: OnOccupied,
  displaceTo?: Address
): RenumberOutcome {
  const occupant = provider.occupantOf(to, notes);

  // The target address already belongs to the SOURCE note itself (e.g. a
  // retry of a renumber that already succeeded). Nothing to do — and
  // critically, nothing to displace: `occupant` here IS `notePath`, so
  // building a displacement step would move the file away from itself and
  // then try to move it back from a path it's no longer at. This check must
  // run before every onOccupied branch below, "fail" included — a note
  // reporting itself as "occupied by" its own path is not a real conflict.
  if (occupant && occupant.path === notePath) {
    return { ok: true, result: { steps: [], displaced: null } };
  }

  // No occupant — single step
  if (occupant === null) {
    const title = provider.titleOf(notePath);
    const toPath = computePath(provider, to, title, notes);
    if (toPath === null) {
      return {
        ok: false,
        error: "cannot determine the expected folder for the target address",
      };
    }

    return {
      ok: true,
      result: {
        steps: [
          {
            from: notePath,
            to: toPath,
          },
        ],
        displaced: null,
      },
    };
  }

  // Occupant exists
  if (onOccupied === "fail") {
    return {
      ok: false,
      error: `${provider.format(to)} is occupied by ${occupant.path} — pass on_occupied to auto-displace or specify displace_to`,
    };
  }

  if (onOccupied === "manual") {
    if (displaceTo === undefined) {
      return {
        ok: false,
        error: "on_occupied is 'manual' but displace_to was not given",
      };
    }

    // displace_to must differ from `to` — otherwise the occupant's own move
    // step would have `from === to` (moveOne rejects that with a confusing
    // "from and to are the same path" error surfaced from deep inside apply,
    // rather than a clear refusal at plan time).
    if (provider.format(displaceTo) === provider.format(to)) {
      return { ok: false, error: "displace_to must differ from to" };
    }

    // Check if displace_to is occupied (and is not the occupant itself, which would be a no-op)
    const displaceOccupant = provider.occupantOf(displaceTo, notes);
    if (displaceOccupant !== null && displaceOccupant.path !== occupant.path) {
      return {
        ok: false,
        error: `displace_to ${provider.format(displaceTo)} is also occupied`,
      };
    }

    // Move occupant first, then source
    const occupantTitle = provider.titleOf(occupant.path);
    const occupantTo = computePath(provider, displaceTo, occupantTitle, notes);
    if (occupantTo === null) {
      return {
        ok: false,
        error: "cannot determine the expected folder to displace the occupant to",
      };
    }

    const sourceTitle = provider.titleOf(notePath);
    const sourceTo = computePath(provider, to, sourceTitle, notes);
    if (sourceTo === null) {
      return {
        ok: false,
        error: "cannot determine the expected folder for the source note",
      };
    }

    return {
      ok: true,
      result: {
        steps: [
          {
            from: occupant.path,
            to: occupantTo,
          },
          {
            from: notePath,
            to: sourceTo,
          },
        ],
        displaced: occupantTo,
      },
    };
  }

  // onOccupied === "auto"
  const occupantScope = provider.scopeOf(occupant.path);
  if (occupantScope === null) {
    return {
      ok: false,
      error: "cannot determine the occupant's scope for auto-displacement",
    };
  }

  const freeAddr = provider.nextFree(occupantScope, notes);
  if (freeAddr === null) {
    return {
      ok: false,
      error: "could not find a free slot to auto-displace the occupant to",
    };
  }

  // Move occupant first, then source
  const occupantTitle = provider.titleOf(occupant.path);
  const occupantTo = computePath(provider, freeAddr, occupantTitle, notes);
  if (occupantTo === null) {
    return {
      ok: false,
      error: "cannot determine the expected folder to auto-displace the occupant to",
    };
  }

  const sourceTitle = provider.titleOf(notePath);
  const sourceTo = computePath(provider, to, sourceTitle, notes);
  if (sourceTo === null) {
    return {
      ok: false,
      error: "cannot determine the expected folder for the source note",
    };
  }

  return {
    ok: true,
    result: {
      steps: [
        {
          from: occupant.path,
          to: occupantTo,
        },
        {
          from: notePath,
          to: sourceTo,
        },
      ],
      displaced: occupantTo,
    },
  };
}
