// vault-conventions.ts — the vault-shaped constants the ported legacy packs
// depend on, in ONE place, injectable, with the current values as defaults.
//
// WHY THIS FILE EXISTS. The four legacy packs are faithful ports of Python
// scripts written for one specific vault, so they necessarily know that vault's
// folder layout: where the registries live, where the plugin-stack note is,
// which template is uid-exempt. That knowledge is legitimate — it is the packs'
// subject matter — but scattering it as string literals through the pack
// sources made it invisible and unchangeable: a different vault could not use
// these packs at all, and changing a path meant a release.
//
// So the values are unchanged (parity keys are byte-identical by construction —
// the defaults ARE the former literals) but they are now named, discoverable in
// one file, and overridable via `GOVERNOR_VAULT_CONVENTIONS` (a JSON object;
// legacy alias `ASSENT_VAULT_CONVENTIONS`) for
// a vault that arranges itself differently.
//
// This does NOT make the packs vault-agnostic — a pack that checks "registry
// entries are named consistently" is meaningful only where such a registry
// exists. It makes the coupling explicit and configurable rather than baked in,
// which is the difference between a documented assumption and a hidden one.

import { envAliased } from "../env-alias.js";

export interface VaultConventions {
  /** Root under which the registry families (action/property/type/tag) live. */
  registriesRoot: string;
  /** The governed system spine's root folder. */
  systemRoot: string;
  /** Artifacts root the port checks resolve module/script/template surfaces under. */
  artifactsRoot: string;
  /** The note recording which plugins are live. */
  pluginStackPath: string;
  /** Notes exempt from the uid-coverage check (payload templates, not identity). */
  uidExemptPaths: string[];
  /** Roots the structure pack never treats as governed content. */
  ungovernedRoots: string[];
}

export const DEFAULT_VAULT_CONVENTIONS: VaultConventions = {
  registriesRoot: "00-09 System/00 System management/00.05 Registries for the system",
  systemRoot: "00-09 System",
  artifactsRoot: "00-09 System/02 Obsidian/02.03 Artifacts for 02 Obsidian",
  pluginStackPath: "00-09 System/02 Obsidian/02.12 Plugin stack.md",
  uidExemptPaths: [
    "00-09 System/00 System management/00.05 Registries for the system/Daily notes/Daily note.template.md",
  ],
  // The framework corpus, ungoverned since it is written as prose rather than
  // filed as vault content. It was the vault-root `Assent/` tree; it was
  // refiled under 00.89 (2026-08-17) and that folder was then renamed from
  // `Assent` to `obsidian-governor` (2026-08-19). One prefix now covers both
  // it and the `Vault archaeology` corpus, which moved inside it — the old
  // bare `"Vault archaeology"` root no longer resolves anywhere in the vault.
  ungovernedRoots: ["00-09 System/00 System management/00.89 obsidian-governor"],
};

/**
 * Conventions for this invocation. `GOVERNOR_VAULT_CONVENTIONS` (legacy alias
 * `ASSENT_VAULT_CONVENTIONS`) is a JSON object
 * merged key-wise over the defaults; malformed JSON falls back to the defaults
 * and warns rather than throwing — a bad override must not take the rail down,
 * and a SILENT fallback would be the absence-read-as-emptiness mistake again.
 */
export function vaultConventionsFrom(env: Record<string, string | undefined>): VaultConventions {
  const raw = (envAliased(env, "VAULT_CONVENTIONS") ?? "").trim();
  if (!raw) return DEFAULT_VAULT_CONVENTIONS;
  try {
    const parsed = JSON.parse(raw) as Partial<VaultConventions>;
    return { ...DEFAULT_VAULT_CONVENTIONS, ...parsed };
  } catch (e) {
    console.error(
      `conformance: GOVERNOR_VAULT_CONVENTIONS (or legacy ASSENT_VAULT_CONVENTIONS) is not valid JSON — using defaults. ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return DEFAULT_VAULT_CONVENTIONS;
  }
}
