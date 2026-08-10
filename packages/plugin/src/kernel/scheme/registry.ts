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

export interface SchemeInstanceConfig {
  id: string;
  provider: "johnny-decimal";
  config?: Partial<JdConfig>;
}

export const DEFAULT_SCHEMES: SchemeInstanceConfig[] = [{ id: "jd", provider: "johnny-decimal" }];

export interface SchemeInstance {
  id: string;
  providerName: string;
  provider: ScopeProvider;
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

export function makeRegistry(configs: SchemeInstanceConfig[]): SchemeRegistry {
  const instances: SchemeInstance[] = [];
  for (const cfg of configs) {
    const factory = PROVIDER_FACTORIES[cfg.provider];
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
    instances.push({ id: cfg.id, providerName: cfg.provider, provider: factory.make(cfg.config) });
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

/** Resolve `ref` (e.g. "jd:06.11") against `notes` to exactly one path, or
 * throw. A ref that isn't a resolvable scheme address at all (unregistered
 * id, unparseable address, "uid:", not scheme-shaped) is treated the same as
 * zero candidates — there is nothing for the caller to have meant. */
export function requireOneAddress(reg: SchemeRegistry, ref: string, notes: string[]): string {
  const parsed = reg.parseRef(ref);
  if (!parsed) {
    throw new AddressUnresolvedError(`"${ref}" does not resolve to any address`);
  }
  const candidates = reg.resolve(parsed.instance, parsed.addr, notes);
  if (candidates.length === 0) {
    throw new AddressUnresolvedError(`no note found for "${ref}"`);
  }
  if (candidates.length > 1) {
    throw new AddressAmbiguousError(`"${ref}" is ambiguous between: ${candidates.join(", ")}`, candidates);
  }
  return candidates[0];
}
