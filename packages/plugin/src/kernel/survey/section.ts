// kernel/survey/section.ts — pure planning core for where a survey snapshot
// goes in a note's body, and whether it's allowed to go there at all.
//
// This is new to vault-mcp: nothing else in the codebase gates a body-content
// write on "who last touched this text." (The plugin's other `provenance`
// module — kernel/provenance/ — is a different concept: DERIVATION metadata
// on a generated artifact, not authorship-protection of a section. Checked
// before writing this; they don't overlap.)
//
// Ported in spirit, not verbatim, from `obsidian-jd-survey`'s gate: a section
// whose last stamp says `by: "claude-code"` or `by: "human"` is prose someone
// deliberately wrote, and a regen must never silently replace it. jd-survey's
// original gate is finer-grained — it refreshes an inner snapshot callout
// while leaving surrounding prose alone. This v1 is coarser: PROTECTED means
// the whole section is left untouched and the plan reports why, rather than
// attempting the same surgical inner-refresh. Splitting the callout back out
// is a reasonable follow-up once this shape is in use; see the module README
// note left in tools-survey.ts.

const HEADING = "## Contents (Filesystem)";
const HEADING_RE = /^## Contents \(Filesystem\)\s*$/m;
const NEXT_HEADING_RE = /^#{1,6} /m;

export type SectionPlanKind = "insert" | "replace" | "protected";

export interface SectionPlan {
  kind: SectionPlanKind;
  /** The full new note body, when kind is "insert" or "replace". Absent
   *  (null) for "protected" — there is nothing to apply. */
  newBody: string | null;
  /** Present only for kind "protected": which stamp value blocked the write,
   *  so a caller can report *why* rather than just *that*. */
  protectedBy?: string;
}

function findSectionRange(body: string): { start: number; end: number } | null {
  const m = HEADING_RE.exec(body);
  if (!m) return null;
  const start = m.index;
  const afterHeading = start + m[0].length;
  NEXT_HEADING_RE.lastIndex = 0;
  const rest = body.slice(afterHeading);
  const next = rest.search(/^#{1,6} /m);
  const end = next === -1 ? body.length : afterHeading + next;
  return { start, end };
}

/**
 * Plan how `snapshotBody` (the freshly-generated content for the section,
 * heading not included) should land in `currentBody`.
 *
 * `stampBy` is the note's own last-recorded `survey.by` (undefined/absent if
 * never surveyed). `force` overrides protection — an explicit human choice,
 * never the default; the write tool that calls this requires the caller to
 * set it, it is not inferred from anything else.
 */
export function planSection(
  currentBody: string,
  snapshotBody: string,
  stampBy: string | undefined,
  force: boolean
): SectionPlan {
  const protectedBy = stampBy === "claude-code" || stampBy === "human" ? stampBy : null;
  const range = findSectionRange(currentBody);

  if (range && protectedBy && !force) {
    return { kind: "protected", newBody: null, protectedBy };
  }

  const rendered = `${HEADING}\n\n${snapshotBody.trim()}\n`;

  if (!range) {
    const trimmed = currentBody.replace(/\s+$/, "");
    const sep = trimmed.length > 0 ? "\n\n" : "";
    return { kind: "insert", newBody: `${trimmed}${sep}${rendered}` };
  }

  const before = currentBody.slice(0, range.start);
  const after = currentBody.slice(range.end);
  return { kind: "replace", newBody: `${before}${rendered}${after.startsWith("\n") ? after : `\n${after}`}` };
}
