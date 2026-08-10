// packs/structure.ts — the structure rule pack: a verbatim TypeScript port of
// conformance_check.py, the blueprint-conformance guard.
//
// The Blueprint plugin owns a note's body structure. On apply, a heading the
// blueprint does not emit is not emitted at all — its content is gone. This
// pack derives each blueprint's emitted H2 set from its source (literal `## `
// lines, `{# #}` comments removed, one level of `{% include %}` resolved,
// `___REST___` fork sections stripped) and compares it to the H2 set of every
// note whose `blueprint:` frontmatter names it.
//
// Findings the ratchet keys (conformance_ratchet.py's `parse_conformance`):
//   - DROPPED — the note carries an H2 its blueprint does not emit; an apply
//     deletes that section. Key ("conformance_check","DROPPED",<path>,<bp base>).
//   - NO-BLUEPRINT — the note names a blueprint file that does not exist. Key
//     ("conformance_check","NO-BLUEPRINT",<path>,<full wikilink inner>).
// REFILL (blueprint emits an H2 the note lacks — a warning) and SKIPPED (a
// dynamic-H2 blueprint that cannot be checked statically) are NOT findings, so
// the pack emits neither, exactly as the ratchet parser dropped them. The pack
// id IS the `script` field: "conformance_check".

import type { Finding } from "../finding.js";
import type { RulePack, SourceFile, VaultSnapshot } from "../rule-pack.js";
import { firstSegment, hasDotOrTrashSegment } from "./legacy-scope.js";

export const STRUCTURE_PACK_ID = "conformance_check";

/** Where the blueprint registry lives (conformance_check.py's BP_ROOTS).
 * Vault-relative; the note→blueprint basename index is built from `.blueprint`
 * files under here. `{% include %}` still resolves against the full blueprint
 * listing, matching the Python (which reads include targets off disk by path). */
export const DEFAULT_BLUEPRINT_ROOT =
  "00-09 System/00 System management/00.05 Registries for the system";

const COMMENT = /{#[\s\S]*?#}/g;
const INCLUDE = /{%-?\s*include\s+"([^"]+)"\s*-?%}/g;
const REST = /{%-?\s*section\s+["']___REST___["'][\s\S]*?{%-?\s*endsection\s*-?%}/g;
const FM_STRIP = /^---\n[\s\S]*?\n---\n/;

/** All literal `## ` headings in a blueprint body (Python's H2 over the whole
 * assembled text — blueprint code fences are NOT skipped here, unlike a note). */
function h2Set(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/^## (.+?)\s*$/gm)) out.add(m[1]);
  return out;
}

export interface EmittedH2 {
  heads: Set<string>;
  dynamic: boolean;
  openEnded: boolean;
}

/** conformance_check.py's `emitted_h2s`: the emitted-H2 set for one blueprint,
 * resolving one level of `{% include %}` (recursively, cycle-guarded by `seen`)
 * and stripping `___REST___` fork sections. `byPath` maps a blueprint's
 * vault-relative path to its raw text. */
export function emittedH2s(startPath: string, byPath: Map<string, string>, seen = new Set<string>()): EmittedH2 {
  if (seen.has(startPath)) return { heads: new Set(), dynamic: false, openEnded: false };
  seen.add(startPath);
  let text = byPath.get(startPath);
  if (text === undefined) return { heads: new Set(), dynamic: false, openEnded: false };
  // Drop the blueprint's own frontmatter (merge payload, not body).
  text = text.replace(FM_STRIP, "");
  text = text.replace(COMMENT, "");
  const restStripped = text.replace(REST, "");
  let openEnded = restStripped !== text;
  text = restStripped;
  // Resolve includes: included H2s count as emitted; sub-openEnded propagates.
  for (const inc of text.matchAll(INCLUDE)) {
    const target = inc[1];
    if (byPath.has(target)) {
      const sub = emittedH2s(target, byPath, seen);
      openEnded = openEnded || sub.openEnded;
      text += "\n" + [...sub.heads].map((h) => `## ${h}`).join("\n");
    }
  }
  const heads = h2Set(text);
  const dynamic = [...heads].some((h) => h.includes("{{"));
  const filtered = new Set([...heads].filter((h) => !h.includes("{{")));
  return { heads: filtered, dynamic, openEnded };
}

/** conformance_check.py's `note_info`: the note's declared blueprint (the inner
 * text of the `blueprint: [[…]]` wikilink) and its H2 headings collected from
 * the body OUTSIDE fenced code blocks. Returns `bp: null` when the note has no
 * leading frontmatter or no `blueprint:` wikilink (→ the note is skipped). */
export function noteInfo(text: string): { bp: string | null; heads: string[] } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { bp: null, heads: [] };
  const bpm = m[1].match(/^blueprint:\s*"?\[\[([^\]]+?)\]\]"?/m);
  if (!bpm) return { bp: null, heads: [] };
  const heads: string[] = [];
  let fence: string | null = null;
  for (const line of m[2].split("\n")) {
    const open = line.match(/^(```+|~~~+)/);
    if (fence) {
      if (open && open[1].length >= fence.length) fence = null;
      continue;
    }
    if (open) {
      fence = open[1];
      continue;
    }
    const hm = line.match(/^## (.+?)\s*$/);
    if (hm) heads.push(hm[1]);
  }
  return { bp: bpm[1], heads };
}

export interface StructurePackOpts {
  /** Vault-relative blueprint-registry root; defaults to DEFAULT_BLUEPRINT_ROOT. */
  blueprintRoot?: string;
}

export function structurePack(opts: StructurePackOpts = {}): RulePack {
  const registryRoot = (opts.blueprintRoot ?? DEFAULT_BLUEPRINT_ROOT).replace(/\/$/, "");
  return {
    id: STRUCTURE_PACK_ID,
    run(snapshot: VaultSnapshot): Finding[] {
      const blueprints: SourceFile[] = snapshot.blueprints ?? [];
      // byPath: every blueprint (include resolution). byBasename: only those
      // under the registry root (the note→blueprint lookup, Python's BP_ROOTS).
      // Sorted input → last-wins on a basename collision is deterministic.
      const byPath = new Map<string, string>();
      const byBasename = new Map<string, string>();
      for (const bp of blueprints) {
        byPath.set(bp.path, bp.text);
        if (bp.path === registryRoot || bp.path.startsWith(registryRoot + "/")) {
          const base = bp.path.split("/").pop() ?? bp.path;
          byBasename.set(base, bp.path);
        }
      }

      const cache = new Map<string, EmittedH2>();
      const emitted = (path: string): EmittedH2 => {
        let e = cache.get(path);
        if (!e) {
          e = emittedH2s(path, byPath);
          cache.set(path, e);
        }
        return e;
      };

      const out: Finding[] = [];
      for (const src of snapshot.sources ?? []) {
        // conformance_check.targets(): no dot/.trash segments, no `_` root, no
        // ungoverned Assent / Vault archaeology roots.
        if (hasDotOrTrashSegment(src.path)) continue;
        const root = firstSegment(src.path);
        if (root.startsWith("_") || root === "Assent" || root === "Vault archaeology") continue;

        const { bp, heads } = noteInfo(src.text);
        if (bp === null) continue;
        const bpKey = bp.split("/").pop() ?? bp;
        const bpPath = byBasename.get(bpKey);
        if (bpPath === undefined) {
          out.push({
            script: STRUCTURE_PACK_ID,
            check: "NO-BLUEPRINT",
            target: src.path,
            kind: bp, // the full wikilink inner, as the ratchet keyed it
            detail: `NO-BLUEPRINT: ${src.path} names [[${bp}]] which does not exist`,
          });
          continue;
        }
        const e = emitted(bpPath);
        if (e.dynamic) continue; // SKIPPED — a dynamic H2 cannot be checked; not a finding
        const dropped = e.openEnded ? [] : heads.filter((h) => !e.heads.has(h));
        if (dropped.length) {
          out.push({
            script: STRUCTURE_PACK_ID,
            check: "DROPPED",
            target: src.path,
            kind: bpKey, // the blueprint basename, as the ratchet keyed it
            detail: `DROPPED on apply: ${src.path} [${bpKey}]: [${dropped.map((h) => `'${h}'`).join(", ")}]`,
          });
        }
        // REFILL (emitted − note) is a warning only — not a finding.
      }
      return out;
    },
  };
}
