// provider.ts — the ScopeProvider contract: the seam between the kernel's
// scheme-agnostic scope operations and a concrete numbering grammar. Johnny
// Decimal (jd.ts) is the first implementation; other schemes plug in behind
// the same shape later. Kernel-module rules apply: nothing here imports from
// "obsidian", not even types — every provider is pure and unit-testable
// without a vault.

/** What a provider can do. `validate` is always true — every scheme can at
 * least recognize a malformed name. The rest are scheme-dependent:
 *   - itemAddresses: whether individual notes carry their own address (JD:
 *     yes — every content note has an id).
 *   - allocate: whether the provider can name a free slot (`nextFree`).
 *   - ordered: whether a scope's members have a natural sort order.
 */
export interface Capabilities {
  validate: true;
  itemAddresses: boolean;
  allocate: boolean;
  ordered: boolean;
}

/**
 * A parsed address in the scheme's grammar.
 *
 * `levels` is the address's FOLDER PATH, top to bottom, as the folder-name
 * token an address would carry at each level of nesting — not the grammar's
 * parsed structural fields (area/category/decimal), which a scheme need not
 * expose at all. It is what `expectedFolder` walks to place a note and what
 * `chainOf` walks in reverse. For Johnny Decimal (default config:
 * expandedAreas ["90-99"], expandedCategories ["27"]):
 *
 *   "00-09"    (area)                        -> ["00-09"]
 *   "06"       (category)                    -> ["00-09", "06"]
 *   "06.11"    (id)                          -> ["00-09", "06", "11"]
 *   "06.110"   (id, 3-digit decimal)         -> ["00-09", "06", "110"]
 *   "92021"    (expanded-item, area 90-99
 *               is itself expanded)          -> ["90-99", "92021"]
 *              — no category folder: an expanded AREA collapses the
 *                category level entirely, items sit directly under the area.
 *   "92021.10" (fractal-id, inside an
 *               expanded area)               -> ["90-99", "92021", "10"]
 *   "27001"    (expanded-item, category 27
 *               is itself expanded)          -> ["20-29", "27", "27001"]
 *              — the category folder SURVIVES: only category 27 flattens to
 *                5-digit ids, the area around it is ordinary.
 *
 * `raw` carries the exact (trimmed) input string `parse` accepted; `format`
 * is defined in terms of it.
 */
export interface Address {
  raw: string;
  kind: string;
  levels: string[];
}

/** A folder-level scope: an area, a category, or (for an expanded scheme) an
 * expanded item acting as its own container. `token` is the folder-name
 * token identifying it (e.g. "00-09", "06"). */
export interface Scope {
  kind: string;
  token: string;
}

/** One note considered as a member of a scope, for `membersOf`. */
export interface Member {
  path: string;
  address: string | null;
}

/** One thing wrong (or worth flagging) about how a note is filed or named. */
export interface SchemeFinding {
  code: "misfiled" | "duplicate_address" | "malformed_name" | "unaddressed";
  path: string;
  detail: string;
}

/**
 * A pluggable numbering/filing scheme. Every method is pure — no I/O, no
 * `obsidian` import — so the kernel can reason about scopes without touching
 * the vault, and a scheme can be fully unit-tested without one.
 */
export interface ScopeProvider {
  readonly capabilities: Capabilities;

  /** Parse a raw address token. Null when it is not a valid address in this
   * scheme's grammar (malformed, not merely unaddressed). */
  parse(raw: string): Address | null;

  /** The canonical string form of a parsed address (round-trips `parse`). */
  format(addr: Address): string;

  /** Extract an address from a note's path, by its filename's leading token.
   * Null when the name carries none. */
  addressOf(path: string): Address | null;

  /** Findings about a filename in isolation (e.g. a leading token that looks
   * like an address but does not parse). Does not require vault context. */
  validateName(filename: string): SchemeFinding[];

  /** The scope (area/category/…) a path lives under, independent of what its
   * own filename says. Null when the path carries no recognizable scope. */
  scopeOf(path: string): Scope | null;

  /** The chain of enclosing scopes for `scope`, self first, root last. */
  chainOf(scope: Scope): Scope[];

  /** The notes (from `notes`) that belong to `scope`. */
  membersOf(scope: Scope, notes: string[]): Member[];

  /** The folder a note with address `addr` should live in, given the current
   * vault listing `notes` (so a provider can resolve folder-note names that
   * only exist as vault state). Null when it cannot be derived.
   *
   * Contract note for callers (added post-merge — findings.ts's
   * schemeFindings relies on this): the result depends ONLY on `addr`'s
   * container token (`addr.levels[addr.levels.length - 2]`, the folder-name
   * token one level up from `addr` itself) — never on the rest of `addr`, on
   * `notes` beyond locating that one token, or on which note is asking. That
   * lets a caller safely memoize per call keyed on the container token alone
   * (see `makeExpectedFolderCache` in findings.ts), turning an O(n) scan per
   * addressed note into one scan per distinct container. A future provider
   * whose `expectedFolder` legitimately varies WITHIN one container (i.e. two
   * addresses sharing a container token but resolving to different expected
   * folders) must not be naively memoized this way — that provider would need
   * its own cache key, or no caching at the call site at all. */
  expectedFolder(addr: Address, notes: string[]): string | null;

  /** The next unused address within `scope`, given `notes`. Null when the
   * capability is absent (`capabilities.allocate === false`) or the scope is
   * full. */
  nextFree(scope: Scope, notes: string[]): Address | null;

  /**
   * Whether `scope` is EVER capable of allocation, independent of vault
   * content — a purely structural judgment (no `notes` argument), distinct
   * from `nextFree` returning null for "this allocatable scope happens to be
   * full right now". `allocatable: false` may carry a `hint` pointing the
   * caller at where allocation is possible instead (e.g. a category folded
   * into an expanded area's band names that area's own scope). Callers still
   * check `capabilities.allocate` first — this only distinguishes, within an
   * allocate-capable provider, which scope KINDS the capability applies to.
   */
  allocatable(scope: Scope): { allocatable: boolean; hint?: string };
}
