// packs/ste.ts — the STE rule pack: a verbatim TypeScript port of ste_lint.py,
// the Simplified Technical English (ASD-STE100) mechanical-subset lint over
// authored prose.
//
// It checks the mechanical rules a regex can decide — no semicolons, no banned
// modals (should/would/may/might/could), no contractions, no present perfect
// (has/have/had been) — over PROSE ONLY: frontmatter, fenced code, inline code,
// wikilink targets, and double-quoted spans are stripped first (prose_lines).
//
// Finding key (the frozen ratchet normalization from conformance_ratchet.py's
// `parse_ste`, fed by `ste_lint --editable-violations`): a per-violation line
// `<path>:<lineno>: <name> '<token>' — <ctx>` becomes
//   ("ste_lint", "editable", <path>, "<name> '<token.toLowerCase()>'").
// The token is LOWER-CASED in the key (a case flip would/Would must not churn),
// line number + context are excluded, and ONLY editable-classified notes are
// keyed — band01 (reviewer-owned architecture prose) and frozen (.04 records)
// are excluded, exactly as `--editable-violations` did. The pack id IS the
// `script` field: "ste_lint".

import type { Finding } from "../finding.js";
import type { RulePack, VaultSnapshot } from "../rule-pack.js";
import { requireSources } from "../rule-pack.js";
import { hasDotOrTrashSegment, firstSegment } from "./legacy-scope.js";

export const STE_PACK_ID = "ste_lint";

/** The four mechanical checks, verbatim from ste_lint.py's CHECKS. `name`
 * becomes the token half of the key. MODAL / PERFECT are case-insensitive;
 * CONTRACTION is case-SENSITIVE (as in the Python); SEMI is a bare `;`. */
const CHECKS: ReadonlyArray<{ name: string; rx: RegExp }> = [
  { name: "semicolon", rx: /;/ },
  { name: "modal", rx: /\b(should|would|may|might|could)\b/i },
  {
    name: "contraction",
    rx: /\b(\w+n't|it's|that's|there's|here's|what's|let's|I'm|you're|we're|they're|I've|you've|we've|they've|I'll|you'll|we'll|they'll|I'd|you'd|we'd|they'd)\b/,
  },
  { name: "present-perfect", rx: /\b(has|have|had) been\b/i },
];

/** ste_lint.py's `prose_lines`: yield (lineno, strippedLine) for prose only —
 * frontmatter skipped, fenced code skipped, inline code + wikilink aliases +
 * double-quoted spans stripped. `text` is universal-newline-normalized. */
export function proseLines(text: string): { line: number; text: string }[] {
  const lines = text.split("\n");
  let i = 0;
  if (lines.length && lines[0] === "---") {
    for (let j = 1; j < lines.length; j++) {
      if (lines[j] === "---") {
        i = j + 1;
        break;
      }
    }
  }
  const out: { line: number; text: string }[] = [];
  let fence: string | null = null;
  for (let n = i; n < lines.length; n++) {
    const line = lines[n];
    const open = line.match(/^(```+|~~~+)/);
    if (fence) {
      if (open && open[1].length >= fence.length) fence = null;
      continue;
    }
    if (open) {
      fence = open[1];
      continue;
    }
    // Strip inline code, wikilink alias prefixes, and double-quoted spans
    // before the checks (quoted error messages and mentioned tokens are exempt).
    let stripped = line.replace(/`[^`]*`/g, "");
    stripped = stripped.replace(/\[\[([^\]|]*)\|/g, "[[");
    stripped = stripped.replace(/"[^"]*"/g, "");
    out.push({ line: n + 1, text: stripped });
  }
  return out;
}

/** ste_lint.py's `lint()`: per prose line, per check first-match. */
export function steHits(text: string): { line: number; name: string; token: string; ctx: string }[] {
  const hits: { line: number; name: string; token: string; ctx: string }[] = [];
  for (const { line, text: prose } of proseLines(text)) {
    for (const { name, rx } of CHECKS) {
      const m = prose.match(rx);
      if (m) {
        hits.push({ line, name, token: m[0], ctx: prose.trim().slice(0, 70) });
      }
    }
  }
  return hits;
}

/** ste_lint.py's `_classify`: bucket a vault-relative path. `.04` records are
 * frozen history; the architecture band (the `01 System architecture` spine or
 * the registries' `System architecture` folder) is reviewer-owned prose;
 * everything else is editable — what a cycle can actually improve. Only
 * "editable" is keyed by the ratchet. */
export function classify(vaultPath: string): "frozen" | "band01" | "editable" {
  if (/\.04 Records for /.test(vaultPath)) return "frozen";
  if (
    vaultPath.includes("/01 System architecture/") ||
    vaultPath.includes("/00.05 Registries for the system/System architecture/")
  ) {
    return "band01";
  }
  return "editable";
}

export function stePack(): RulePack {
  return {
    id: STE_PACK_ID,
    run(snapshot: VaultSnapshot): Finding[] {
      const out: Finding[] = [];
      // De-dupe (path, "name 'token'") so identical-token hits in one file
      // collapse — the ratchet key excludes line + context.
      const seen = new Set<string>();
      for (const src of requireSources(snapshot, STE_PACK_ID)) {
        // scan_vault scope: no dot/.trash segments, no `_`-prefixed root, no
        // ungoverned Assent root. Then classify → editable only.
        if (hasDotOrTrashSegment(src.path)) continue;
        const root = firstSegment(src.path);
        if (root.startsWith("_") || root === "Assent") continue;
        if (classify(src.path) !== "editable") continue;
        for (const h of steHits(src.text)) {
          const kind = `${h.name} '${h.token.toLowerCase()}'`;
          const dedupe = `${src.path}\u0000${kind}`;
          if (seen.has(dedupe)) continue;
          seen.add(dedupe);
          out.push({
            script: STE_PACK_ID,
            check: "editable",
            target: src.path,
            kind,
            detail: `${src.path}:${h.line}: ${h.name} '${h.token}' — ${h.ctx}`,
          });
        }
      }
      return out;
    },
  };
}
