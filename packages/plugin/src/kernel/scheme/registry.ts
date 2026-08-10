// registry.ts — the SchemeRegistry: multiple named scheme instances (each a
// provider name + a merged config) plus address-string resolution
// ("jd:06.11" -> a vault path). Kernel-module rules apply: nothing here
// imports from "obsidian".
//
// Scheme semantics are configuration, not hardwired (Nelson's ruling): each
// instance's config is a PARTIAL provider config, deep-merged at the key
// level over that provider's own default config — {expandedCategories:
// ["27","31"]} overrides only that key and leaves expandedAreas at the
// provider default. The registry itself introduces no new semantic
// constants; it only wires a provider name + merged config to a live
// ScopeProvider.

import type { Address, ScopeProvider } from "./provider.js";
import { jdProvider, DEFAULT_JD_CONFIG, validateJdConfig, type JdConfig } from "./jd.js";
import { mapPaths, visiblePaths, type GuardSettings } from "../../guard.js";

export interface SchemeInstanceConfig {
  id: string;
  provider: "johnny-decimal";
  config?: Partial<JdConfig>;
  /**
   * Vault-relative folder prefixes whose contents are invisible to THIS
   * scheme instance — instance-level and provider-agnostic (a sibling of
   * `config`, not a key inside it: exclusion is about which territory this
   * instance speaks for, not about the provider's own grammar). Motivating
   * case: an archive tree that reuses live-spine addresses (two notes both
   * claiming `jd:02.10`) — excluding the archive root lets the instance
   * resolve cleanly to the live one without renaming anything.
   *
   * Applied uniformly at the listing layer (`excludeRoots`, below) wherever a
   * listing reaches this instance's provider: tools-scheme.ts's per-call
   * visible listing, `resolveSchemeArgs`'s `jd:<address>` addressing, and
   * `schemeFindings`. It bounds SCHEME resolution and scheme tool output
   * ONLY — an excluded note's own path still works as an ordinary path
   * argument (read, write, uid resolution, …); this is not a second
   * allowlist.
   */
  excludedRoots?: string[];
}

export const DEFAULT_SCHEMES: SchemeInstanceConfig[] = [{ id: "jd", provider: "johnny-decimal" }];

export interface SchemeInstance {
  id: string;
  providerName: string;
  provider: ScopeProvider;
  /** Validated, normalized (trailing slash stripped) excluded-root prefixes.
   * Absent (not empty array) when the instance configured none — matches
   * `excludeRoots`'s "absent/empty ⇒ same array back" identity convention,
   * and keeps the JSON `obsidian_schemes` reports free of a noisy `[]`. */
  excludedRoots?: string[];
}

/**
 * One entry per known provider name: how to deep-merge a partial config over
 * that provider's own defaults (key-level — each key either takes the
 * override wholesale or falls back to the default, never merged deeper),
 * validate a raw config before trusting it, and build the live ScopeProvider.
 * `config` arrives as `unknown` because `SchemeInstanceConfig.provider` is a
 * compile-time literal, but a config loaded from JSON can name any string at
 * runtime — the registry must validate it defensively, not trust the type.
 *
 * Flexible user config schema (Nelson's ruling): `config` is a per-provider
 * namespace validated BY THE PROVIDER, not by the registry — `validate` is
 * the provider's own hook (validateJdConfig for "johnny-decimal"), and
 * makeRegistry below calls it before `make`, same skip-and-report path as an
 * unknown provider name.
 */
const PROVIDER_FACTORIES: Record<string, { make: (config: unknown) => ScopeProvider; validate: (config: unknown) => string[] }> = {
  "johnny-decimal": {
    make: (config) => jdProvider({ ...DEFAULT_JD_CONFIG, ...(config as Partial<JdConfig> | undefined) }),
    validate: validateJdConfig,
  },
};

/** "jd:06.11", "uid:abc" — a scheme id (lowercase, digits/hyphens) and an
 * address, colon-separated. Matched by parseRef against the registry's own
 * instance ids; `uid:` is reserved and never a scheme ref. */
const REF_RE = /^([a-z][a-z0-9-]*):(.+)$/;

export class SchemeRegistry {
  private readonly byId: Map<string, SchemeInstance>;

  constructor(instances: SchemeInstance[]) {
    this.byId = new Map(instances.map((inst) => [inst.id, inst]));
  }

  instances(): SchemeInstance[] {
    return [...this.byId.values()];
  }

  get(id: string): SchemeInstance | null {
    return this.byId.get(id) ?? null;
  }

  /** "jd:06.11" -> { instance, addr } | null. Null covers every reason the
   * ref isn't a resolvable scheme address: not scheme-shaped at all, the
   * reserved "uid:" prefix, an unregistered scheme id, or an id-shaped
   * address the provider itself can't parse. Callers treat null uniformly as
   * "not a scheme ref — treat it as an ordinary path", so a filename that
   * happens to contain a colon never breaks. */
  parseRef(ref: string): { instance: SchemeInstance; addr: Address } | null {
    const m = ref.match(REF_RE);
    if (!m) return null;
    const [, id, rest] = m;
    if (id === "uid") return null;
    const instance = this.get(id);
    if (!instance) return null;
    const addr = instance.provider.parse(rest);
    if (!addr) return null;
    return { instance, addr };
  }

  /** Paths in `notes` whose own address canonicalizes to the same string as
   * `addr`, in listing order. Compares via provider.format on both sides —
   * canonical-form equality, not raw-string equality (so e.g. differing
   * decimal widths that the provider itself normalizes still match). */
  resolve(instance: SchemeInstance, addr: Address, notes: string[]): string[] {
    const target = instance.provider.format(addr);
    const matches: string[] = [];
    for (const path of notes) {
      const a = instance.provider.addressOf(path);
      if (a && instance.provider.format(a) === target) matches.push(path);
    }
    return matches;
  }
}

/**
 * Validate + normalize one instance's `excludedRoots`. Same skip-and-report
 * convention as `validateJdConfig`: `problems` non-empty means the WHOLE
 * instance is skipped by `makeRegistry`, not just the bad entries silently
 * dropped — a typo'd root that got dropped would leave the exclusion the
 * user asked for simply not happening, with no on-screen sign why.
 *
 * Per-entry rules: non-empty string; relative (no leading "/"); no ".."
 * segment (would escape the vault root the same way `guardCall`'s traversal
 * check exists to catch); not "." (names nothing to exclude); a trailing
 * slash is NORMALIZED away rather than refused, matching `guardCall`'s own
 * allowlist-prefix normalization (`p.replace(/\/+$/, "")`) — a user typing
 * "Vault archaeology/" is not making a mistake worth failing the instance
 * over.
 *
 * `raw` undefined (field absent) ⇒ `{roots: undefined, problems: []}`, never
 * `{roots: [], problems: []}` — keeps the "absent means no exclusion, same
 * array back" identity `excludeRoots` relies on working off `undefined`
 * rather than an incidental empty array.
 */
export function validateExcludedRoots(raw: string[] | undefined): { roots: string[] | undefined; problems: string[] } {
  if (raw === undefined) return { roots: undefined, problems: [] };
  const problems: string[] = [];
  const roots: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0) {
      problems.push(`excludedRoots entry ${JSON.stringify(entry)} must be a non-empty string`);
      continue;
    }
    if (entry.startsWith("/")) {
      problems.push(`excludedRoots entry "${entry}" must be relative (no leading "/")`);
      continue;
    }
    if (entry.split("/").includes("..")) {
      problems.push(`excludedRoots entry "${entry}" must not contain ".." segments`);
      continue;
    }
    const normalized = entry.replace(/\/+$/, "");
    if (normalized === "." || normalized.length === 0) {
      problems.push(`excludedRoots entry "${entry}" does not name a folder`);
      continue;
    }
    roots.push(normalized);
  }
  return { roots: roots.length > 0 ? roots : undefined, problems };
}

/**
 * `paths` with every entry under one of `roots` removed — segment-boundary
 * prefix matching, same style as `guard.ts`'s `visiblePaths`/`isVisible`: a
 * root excludes its own exact path and everything one or more path segments
 * below it ("Vault archaeology" excludes "Vault archaeology/x.md" but NOT
 * "Vault archaeology2/x.md" — a bare string-prefix check would wrongly
 * exclude the latter).
 *
 * `roots` empty/absent, or nothing in `paths` matches, returns the SAME
 * ARRAY (`paths`, not a copy) — the identity convention every caller downstream
 * (the visible-listing memo in `resolveSchemeArgs`, `mapPaths`'s no-op
 * sharing) relies on to treat "unchanged" as `===`, and the byte-identical
 * behavior `excludedRoots` absent/`[]` must have.
 */
export function excludeRoots(paths: string[], roots: string[] | undefined): string[] {
  if (!roots || roots.length === 0) return paths;
  let changed = false;
  const out: string[] = [];
  for (const path of paths) {
    const excluded = roots.some((root) => path === root || path.startsWith(root + "/"));
    if (excluded) {
      changed = true;
      continue;
    }
    out.push(path);
  }
  return changed ? out : paths;
}

export function makeRegistry(configs: SchemeInstanceConfig[]): SchemeRegistry {
  const instances: SchemeInstance[] = [];
  // FIRST wins on a duplicate id (item 5 fix): a later entry sharing an
  // already-registered id is skip-and-reported, same convention as an
  // unknown provider or an invalid config — not silently last-wins, which
  // let a later, possibly-unintended entry shadow an earlier one with no
  // trace in the log. Tracked by id alongside `instances` rather than
  // `byId.has(...)` inside the SchemeRegistry constructor, since that
  // constructor is also used directly (see e.g. requireOneAddress's tests)
  // and must keep its own simpler last-wins-by-Map semantics for a caller
  // that already deduplicated.
  const seenIds = new Set<string>();
  for (const cfg of configs) {
    if (seenIds.has(cfg.id)) {
      console.error(`[scheme-registry] duplicate scheme id "${cfg.id}" — first entry wins, this one is skipped`);
      continue;
    }
    // Reserve the id BEFORE the provider/config checks below (worker-1's
    // review, post-merge — mirrors kernel/vocab/registry.ts's VocabRegistry
    // constructor, which fixed the identical gap): a row that fails those
    // checks is still SKIPPED, not absent — the id it named is spoken for
    // and must not be silently claimable by a later row of the same id. Add
    // here, not after `instances.push`, or a first row skipped for an
    // unknown provider/invalid config would leave the id unreserved and a
    // later same-id row would register as if it were the only one.
    seenIds.add(cfg.id);
    const factory = Object.prototype.hasOwnProperty.call(PROVIDER_FACTORIES, cfg.provider)
      ? PROVIDER_FACTORIES[cfg.provider]
      : undefined;
    if (!factory) {
      console.error(`[scheme-registry] unknown provider "${cfg.provider}" for scheme id "${cfg.id}" — instance skipped`);
      continue;
    }
    const problems = factory.validate(cfg.config);
    if (problems.length > 0) {
      console.error(
        `[scheme-registry] invalid config for scheme id "${cfg.id}" (provider "${cfg.provider}") — instance skipped: ${problems.join("; ")}`,
      );
      continue;
    }
    const { roots: excludedRoots, problems: rootProblems } = validateExcludedRoots(cfg.excludedRoots);
    if (rootProblems.length > 0) {
      console.error(
        `[scheme-registry] invalid excludedRoots for scheme id "${cfg.id}" — instance skipped: ${rootProblems.join("; ")}`,
      );
      continue;
    }
    instances.push({ id: cfg.id, providerName: cfg.provider, provider: factory.make(cfg.config), ...(excludedRoots ? { excludedRoots } : {}) });
  }
  return new SchemeRegistry(instances);
}

export class AddressUnresolvedError extends Error {
  readonly code = "address_unresolved";

  constructor(message: string) {
    super(message);
    this.name = "AddressUnresolvedError";
  }
}

export class AddressAmbiguousError extends Error {
  readonly code = "address_ambiguous";

  constructor(
    message: string,
    readonly candidates: string[],
  ) {
    super(message);
    this.name = "AddressAmbiguousError";
  }
}

// A duplicate can in principle be large; an error message should not be — same
// convention (and same cap) as UidAmbiguousError's MAX_LISTED_PATHS in
// uid-index.ts. The candidates are already allowlist-VISIBLE-only by the time
// they get here, so this bounds the wire size, not disclosure.
const MAX_LISTED_CANDIDATES = 10;

/**
 * The post-parse half of `requireOneAddress`: given a ref ALREADY PARSED (or
 * `null`, meaning `ref` never parsed as a scheme reference at all), decide the
 * one matching path or throw. Factored out so a caller that must parse `ref`
 * itself anyway to decide whether it's scheme-shaped — resolveSchemeArgs,
 * below — never parses it a SECOND time just to resolve it.
 */
function resolveParsedAddress(
  reg: SchemeRegistry,
  parsed: { instance: SchemeInstance; addr: Address } | null,
  ref: string,
  notes: string[]
): string {
  if (!parsed) {
    throw new AddressUnresolvedError(`"${ref}" does not resolve to any address`);
  }
  const candidates = reg.resolve(parsed.instance, parsed.addr, notes);
  if (candidates.length === 0) {
    throw new AddressUnresolvedError(`no note found for "${ref}"`);
  }
  if (candidates.length > 1) {
    const listed = candidates.slice(0, MAX_LISTED_CANDIDATES);
    const more = candidates.length > listed.length ? `, +${candidates.length - listed.length} more` : "";
    throw new AddressAmbiguousError(`"${ref}" is ambiguous between: ${listed.join(", ")}${more}`, candidates);
  }
  return candidates[0];
}

/** Resolve `ref` (e.g. "jd:06.11") against `notes` to exactly one path, or
 * throw. A ref that isn't a resolvable scheme address at all (unregistered
 * id, unparseable address, "uid:", not scheme-shaped) is treated the same as
 * zero candidates — there is nothing for the caller to have meant. */
export function requireOneAddress(reg: SchemeRegistry, ref: string, notes: string[]): string {
  return resolveParsedAddress(reg, reg.parseRef(ref), ref, notes);
}

// ── scheme addressing (`jd:<address>`) ──────────────────────────────────────
//
// The uid-addressing analog (see kernel/uid-index.ts's resolveUidArgs, applied
// at the same interception point in mcp/guarded.ts): `path: "jd:06.11"`
// resolves to the real path before anything else sees the call. Defined over
// the guard's own path walker (mapPaths), so the arguments scheme addressing
// reaches and the arguments the allowlist scopes are the same set by
// construction, exactly as uid addressing is.
//
// Resolution runs over the allowlist-VISIBLE notes only (`visiblePaths`, the
// same helper `obsidian_resolve_address` uses) — 0 visible candidates ⇒
// address_unresolved even when a hidden note claims the address, 2+ visible ⇒
// address_ambiguous naming ONLY the visible ones. A duplicated address with
// one hidden claimant must not read as more resolvable, and disambiguous, to
// an allowlisted session than to obsidian_resolve_address — the same
// no-existence-oracle property uid addressing's D-A fix established.

/** What a call's scheme addressing resolved to — the `jd:<address>` analog of
 * `UidAddressing`. */
export interface SchemeAddressing {
  /**
   * The arguments with every scheme reference replaced by its resolved path.
   * The SAME object when the call used no scheme addressing at all —
   * behavior for ordinary path arguments (including ones merely containing a
   * colon) is unchanged, byte for byte.
   */
  args: Record<string, unknown>;
  /** Each reference resolved, in walk order. Empty ⇒ no scheme addressing was used. */
  resolved: Array<{ ref: string; path: string }>;
}

/**
 * Rewrite every `<scheme-id>:<address>` path argument (e.g. `jd:06.11`) to the
 * path it names.
 *
 * Throws AddressUnresolvedError / AddressAmbiguousError — the caller (makeGuarded)
 * renders them as typed tool errors and nothing runs. `reg` absent (no scheme
 * registry configured for this call) ⇒ every value is left untouched, same as
 * a value whose `parseRef` is null: a filename that happens to contain a colon,
 * or an unregistered scheme id, is never mistaken for an address.
 *
 * `notes()` — and the allowlist filter over it — is computed LAZILY and AT MOST
 * ONCE per call: nothing runs until a scheme-shaped value is actually met, and
 * from then on every further value in the SAME call reuses the one listing.
 * Before this memoization a K-address batch enumerated and allowlist-filtered
 * the whole vault K times (O(K x N) against a single mapPaths walk) — a real
 * cost on a large vault, and one a read-only sandboxed session could trigger
 * synchronously, unserialized, since reads never take the write queue.
 *
 * Exclusion (`SchemeInstanceConfig.excludedRoots`) is applied AFTER the
 * shared `visible` memo, per ref, keyed on THAT ref's own instance
 * (`excludeRoots(visible, parsed.instance.excludedRoots)`) — exclusion is
 * per-instance while the visible listing is call-wide, so a batch mixing
 * refs across two instances with different excluded roots still shares the
 * one `visiblePaths` computation and only refilters (a cheap array scan) per
 * instance actually used.
 */
export function resolveSchemeArgs(
  args: Record<string, unknown>,
  reg: SchemeRegistry | null,
  notes: () => string[],
  settings?: GuardSettings | null
): SchemeAddressing {
  const resolved: Array<{ ref: string; path: string }> = [];
  // undefined ⇒ not yet computed for this call; set once, on the FIRST
  // scheme-shaped value, then reused for every subsequent one.
  let visible: string[] | undefined;
  const rewritten = mapPaths(args ?? {}, (value) => {
    if (!reg) return value;
    const parsed = reg.parseRef(value);
    if (!parsed) return value;
    if (visible === undefined) visible = visiblePaths(notes(), settings);
    const candidates = excludeRoots(visible, parsed.instance.excludedRoots);
    const path = resolveParsedAddress(reg, parsed, value, candidates);
    resolved.push({ ref: value, path });
    return path;
  });
  return { args: rewritten, resolved };
}
