// render.ts — render the plugin-audit note text, and preserve hand-written
// `<!-- human:start … -->` sections across regenerations. Port of the Python
// `render.py`. Pure string manipulation, no source access.

import type { Reconciliation } from "./plugins.js";
import { SOURCE_COUNT_FIELD } from "./freshness.js";
import {
  AUDIT_GENERATOR,
  AUDIT_DERIVATION_MODE,
  DEFAULT_NOTES_DIR,
  auditDerivedFrom,
} from "./provenance-config.js";

// The Python pattern, verbatim in JS: `re.DOTALL` → `[\s\S]`, `(?P<name>…)` →
// capture group 1, `(?P<body>…)` → group 2. A section name is `[\w-]+`.
const HUMAN_SECTION_RE = /<!-- human:start ([\w-]+) -->\n([\s\S]*?)<!-- human:end -->/g;

/** Map each human-section NAME to its hand-written body (the text between the
 *  start/end markers), so a regeneration can carry it forward. */
export function extractSections(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(HUMAN_SECTION_RE)) out[m[1]] = m[2];
  return out;
}

/** Re-insert preserved human-section bodies into freshly rendered text: for
 *  each `<!-- human:start NAME -->…<!-- human:end -->` block, substitute
 *  `preserved[NAME]` when present, else keep the freshly rendered body. */
export function reinsertSections(rendered: string, preserved: Record<string, string>): string {
  return rendered.replace(HUMAN_SECTION_RE, (_full, name: string, body: string) => {
    const kept = Object.prototype.hasOwnProperty.call(preserved, name) ? preserved[name] : body;
    return `<!-- human:start ${name} -->\n${kept}<!-- human:end -->`;
  });
}

/** Render the full plugin-audit note text (frontmatter + body) from a
 *  reconciliation. The frontmatter stamps DERIVATION metadata only
 *  (`derived-from` / `generated` / `generator` / `derivation-mode`, plus the
 *  `derived-source-count` witness when the caller supplies one) — never an
 *  acceptance field.
 *
 *  `sourceCount` is the number of files the `derived-from` set resolved to at
 *  generation time; stamping it lets `provenance_check` later detect sources
 *  DELETED out of the globbed set, which no mtime comparison can see. Omitted
 *  (or not a non-negative integer) ⇒ the field is not emitted and the note
 *  checks exactly as it did before the witness existed. */
export function renderAudit(
  recon: Reconciliation,
  generated: string,
  notesDir: string = DEFAULT_NOTES_DIR,
  sourceCount?: number,
): string {
  const lines: string[] = [
    "---",
    "derived-from:",
    ...auditDerivedFrom(notesDir).map((e) => `  - "${e}"`),
    ...(Number.isInteger(sourceCount) && (sourceCount as number) >= 0
      ? [`${SOURCE_COUNT_FIELD}: ${sourceCount}`]
      : []),
    `generated: ${generated}`,
    `generator: ${AUDIT_GENERATOR}`,
    `derivation-mode: ${AUDIT_DERIVATION_MODE}`,
    "---",
    "",
    "# 08.10 Obsidian plugins — audit",
    "",
    `- Installed: ${Object.keys(recon.installed).length}`,
    `- Enabled: ${recon.enabled.length}`,
    `- Noted: ${Object.keys(recon.noted).length}`,
    `- Installed but unnoted: ${recon.unnoted.length}`,
    "",
    "## Installed but unnoted",
    "",
  ];
  lines.push(...(recon.unnoted.length ? recon.unnoted.map((id) => `- \`${id}\``) : ["- (none)"]));
  lines.push("", "## Version drift (note vs manifest)", "");
  lines.push(
    ...(recon.staleVersion.length
      ? recon.staleVersion.map(([id, nv, mv]) => `- \`${id}\`: note ${nv} → manifest ${mv}`)
      : ["- (none)"]),
  );
  lines.push("", "## Notes", "", "<!-- human:start notes -->", "", "<!-- human:end -->", "");
  return lines.join("\n");
}
