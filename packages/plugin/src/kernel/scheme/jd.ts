// jd.ts — the Johnny Decimal ScopeProvider.
//
// The grammar core below (parseJdId, areaOfCategory, categoryOf,
// isExpandedCategory, isExpandedAreaItem, isStandardZero, idTokenFromName,
// nextContentDecimal) is ported VERBATIM from obsidian-johnny-decimal's
// src/core/jdId.ts — same regexes, same branch order, same edge cases. Only
// names that the ScopeProvider interface forces have changed (CoreConfig ->
// JdConfig, DEFAULT_CONFIG -> DEFAULT_JD_CONFIG). See that file's header for
// the full shape catalogue and the three predecessors it reconciles:
//
//   - area          XX-YY            e.g. 00-09, 90-99   (hyphen, not en-dash)
//   - category      XX               e.g. 06, 72
//   - id            XX.YY / XX.YYY   e.g. 06.11, 06.110
//   - expanded-item NNNNN            e.g. 92021 (expanded area) or 27001 (expanded category)
//   - fractal-id    NNNNN.YY         e.g. 92021.10 (inside an expanded area)
//
// Everything else (e.g. "26 2.18") is malformed.
//
// This task (Task 1) implements parse/format/addressOf/validateName plus
// capabilities. scopeOf/chainOf/membersOf/expectedFolder/nextFree are
// stubbed to throw ("task 2") — plan-mandated, not an oversight, so the file
// typechecks against the full ScopeProvider shape while later tasks fill
// in the vault-aware half. The grammar helpers below are ported in full now
// (not just the subset Task 1 calls) so Task 2 has them ready rather than
// re-porting the same source a second time.

import type { Address, Capabilities, Member, Scope, SchemeFinding, ScopeProvider } from "./provider.js";

export interface JdConfig {
  /** Areas whose whole band uses 5-digit sequential IDs, e.g. ["90-99"]. */
  expandedAreas: string[];
  /** Single categories that use 5-digit flat IDs, e.g. ["27"]. */
  expandedCategories: string[];
}

export const DEFAULT_JD_CONFIG: JdConfig = {
  expandedAreas: ["90-99"],
  expandedCategories: ["27"],
};

// ── grammar core (ported verbatim from obsidian-johnny-decimal/src/core/jdId.ts) ──

type JdKind = "area" | "category" | "id" | "expanded-item" | "fractal-id";

interface ParsedId {
  raw: string;
  kind: JdKind;
  /** Area band, e.g. "00-09". */
  area: string;
  /** Category code, e.g. "06" (empty for a bare area); the full 5-digit
   * token for a fractal-id, matching the source's field reuse. */
  category: string;
  /** Decimal part for id/fractal-id (e.g. "11", "110", "10"); null otherwise. */
  decimal: string | null;
}

/** The area band (e.g. "90-99") that a 2-digit category (e.g. "92") belongs to. */
function areaOfCategory(cat: string): string {
  const d = cat[0];
  return `${d}0-${d}9`;
}

const RE_AREA = /^([0-9])0-([0-9])9$/; // 00-09, 10-19, ... 90-99 (digits must match)
const RE_CATEGORY = /^[0-9]{2}$/;
const RE_ID = /^([0-9]{2})\.([0-9]{2,3})$/; // widened to 2–3 digit decimal (survey)
const RE_FRACTAL = /^([0-9]{5})\.([0-9]{2})$/;
const RE_FIVE = /^([0-9]{5})$/;

/**
 * Parse a raw jd-id string. Returns null when the string is not a valid JD
 * identifier under the given config (i.e. it is malformed / not a JD id).
 */
function parseJdId(raw: string, cfg: JdConfig): ParsedId | null {
  const s = raw.trim();

  const am = s.match(RE_AREA);
  if (am && am[1] === am[2]) {
    return { raw: s, kind: "area", area: s, category: "", decimal: null };
  }
  if (RE_CATEGORY.test(s)) {
    return { raw: s, kind: "category", area: areaOfCategory(s), category: s, decimal: null };
  }
  let m = s.match(RE_ID);
  if (m) {
    return { raw: s, kind: "id", area: areaOfCategory(m[1]), category: m[1], decimal: m[2] };
  }
  m = s.match(RE_FRACTAL);
  if (m) {
    const cat = m[1].slice(0, 2);
    if (cfg.expandedAreas.includes(areaOfCategory(cat))) {
      return { raw: s, kind: "fractal-id", area: areaOfCategory(cat), category: cat, decimal: m[2] };
    }
    return null;
  }
  m = s.match(RE_FIVE);
  if (m) {
    const cat = s.slice(0, 2);
    if (cfg.expandedAreas.includes(areaOfCategory(cat)) || cfg.expandedCategories.includes(cat)) {
      return { raw: s, kind: "expanded-item", area: areaOfCategory(cat), category: cat, decimal: null };
    }
    return null;
  }
  return null;
}

/**
 * The 2-digit category of any JD id form, config-agnostic (dashboard semantics):
 *   06.12 -> 06, 06.110 -> 06, 92001 -> 92, 92021.10 -> 92, 00-09 -> 00, 06 -> 06.
 * A leading `+SUFFIX` (Extend-the-End) and any trailing title are stripped first.
 * Returns null when the token is not a recognizable JD id shape.
 * NOTE: a non-null result does NOT imply parseJdId accepts the token — categoryOf
 * is deliberately loose (e.g. malformed area "05-19" -> "05" here, but null from
 * parseJdId). Use parseJdId when you need validity, not just the category.
 */
function categoryOf(id: string): string | null {
  const token = id.trim().split(" ")[0].split("+")[0];
  // Every JD id form begins with a 2-digit category.
  if (/^\d{2}(-\d{2}|\.\d{2,3}|\d{3}(\.\d{2})?)?$/.test(token)) {
    return token.slice(0, 2);
  }
  return null;
}

/** True when the category uses 5-digit IDs (expanded area or expanded category). */
function isExpandedCategory(cat: string, cfg: JdConfig): boolean {
  return cfg.expandedCategories.includes(cat) || cfg.expandedAreas.includes(areaOfCategory(cat));
}

/**
 * True when `id` is a 5-digit item (or fractal) belonging to an EXPANDED AREA
 * (as opposed to an expanded category).
 */
function isExpandedAreaItem(id: string, cfg: JdConfig): boolean {
  const p = parseJdId(id, cfg);
  return !!p && (p.kind === "expanded-item" || p.kind === "fractal-id") && cfg.expandedAreas.includes(p.area);
}

/** Standard-zero slots .00–.09 are reserved for infrastructure, not content. */
function isStandardZero(id: ParsedId): boolean {
  if (id.kind !== "id" || id.decimal === null) return false;
  // Standard zeros are the 2-digit slots .00–.09; a 3-digit decimal is never one.
  return id.decimal.length === 2 && parseInt(id.decimal, 10) <= 9;
}

/**
 * Strip an Extend-the-End suffix (e.g. "43.11+2024 Foo" -> "43.11") and a
 * trailing title, returning just the leading id token of a filename.
 * Returns the raw token (still needs parseJdId to validate).
 */
function idTokenFromName(name: string): string {
  const token = name.split(" ")[0];
  const plus = token.indexOf("+");
  return plus === -1 ? token : token.slice(0, plus);
}

/**
 * Given a set of used decimal parts in a normal category, return the next free
 * two-digit content decimal (".10".."".99"), or null if the category is full.
 * Content IDs start at .10 — .00–.09 are the reserved standard zeros.
 */
function nextContentDecimal(used: Set<number>): string | null {
  for (let n = 10; n <= 99; n++) {
    if (!used.has(n)) return String(n).padStart(2, "0");
  }
  return null;
}

// categoryOf / isExpandedCategory / isExpandedAreaItem / isStandardZero /
// nextContentDecimal are not called by this task's four methods — they exist
// here, ported and ready, for Task 2's scopeOf/nextFree.

// ── Address <-> ParsedId ─────────────────────────────────────────────────────

/** See the `Address.levels` doc in provider.ts for the folder-path convention
 * this builds — the folder-name token an address carries at each nesting
 * level, not the grammar's own structural fields. */
function levelsOf(p: ParsedId, cfg: JdConfig): string[] {
  switch (p.kind) {
    case "area":
      return [p.area];
    case "category":
      return [p.area, p.category];
    case "id":
      return [p.area, p.category, p.decimal as string];
    case "fractal-id":
      // p.category here is only the 2-digit prefix (parseJdId's fractal
      // branch slices m[1] to 2 digits, verbatim) — the folder token is the
      // full 5-digit item, which is the part of `raw` before the dot.
      return [p.area, p.raw.split(".")[0], p.decimal as string];
    case "expanded-item":
      // An expanded AREA collapses the category folder entirely (items sit
      // directly under the area); an expanded CATEGORY keeps its folder and
      // only flattens the ids within it.
      return cfg.expandedAreas.includes(p.area) ? [p.area, p.raw] : [p.area, p.category, p.raw];
    default: {
      const _exhaustive: never = p.kind;
      throw new Error(`unreachable JdKind: ${String(_exhaustive)}`);
    }
  }
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/** A leading token that at least LOOKS like a JD id (digits, dots, hyphens) —
 * used to distinguish "malformed address" from "simply not addressed". */
const LOOKS_NUMERIC = /^[0-9][0-9.\-]*$/;

// ── the provider ─────────────────────────────────────────────────────────────

export function jdProvider(cfg: JdConfig): ScopeProvider {
  const capabilities: Capabilities = { validate: true, itemAddresses: true, allocate: true, ordered: true };

  function toAddress(p: ParsedId): Address {
    return { raw: p.raw, kind: p.kind, levels: levelsOf(p, cfg) };
  }

  function parse(raw: string): Address | null {
    const p = parseJdId(raw, cfg);
    return p ? toAddress(p) : null;
  }

  function format(addr: Address): string {
    return addr.raw;
  }

  function addressOf(path: string): Address | null {
    const token = idTokenFromName(basename(path));
    return parse(token);
  }

  function validateName(filename: string): SchemeFinding[] {
    const token = idTokenFromName(filename);
    if (LOOKS_NUMERIC.test(token) && parseJdId(token, cfg) === null) {
      return [
        {
          code: "malformed_name",
          path: filename,
          detail: `'${token}' looks like a Johnny Decimal id but does not parse`,
        },
      ];
    }
    return [];
  }

  return {
    capabilities,
    parse,
    format,
    addressOf,
    validateName,
    scopeOf(_path: string): Scope | null {
      throw new Error("task 2");
    },
    chainOf(_scope: Scope): Scope[] {
      throw new Error("task 2");
    },
    membersOf(_scope: Scope, _notes: string[]): Member[] {
      throw new Error("task 2");
    },
    expectedFolder(_addr: Address, _notes: string[]): string | null {
      throw new Error("task 2");
    },
    nextFree(_scope: Scope, _notes: string[]): Address | null {
      throw new Error("task 2");
    },
  };
}
