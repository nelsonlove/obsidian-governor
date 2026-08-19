// Ported from obsidian-jd-dashboard's src/lib/sections.ts. A generic
// `## Heading` section upsert — unlike kernel/survey/section.ts's sibling
// (hardcoded to one heading, refusal-shaped for protected human prose), this
// one is a plain heading-parameterized replace: category-index has no
// protection gate at all, it always regenerates by design.

/**
 * Upsert a top-level `## Heading` section. Replaces the entire region from
 * the heading line up to (but not including) the next top-level `##`
 * heading, the `^contents` anchor, or EOF — whichever comes first. Inserts
 * a new section at the end of the file if the heading isn't found.
 *
 * (`^contents` is a block-ref some pre-flat-schema folder notes placed at
 * the bottom of the auto-managed region. New code doesn't emit it, but
 * legacy notes still in the wild use it as a section terminator — honored
 * here so a reindex doesn't bulldoze custom prose appearing after it.)
 */
export function setSection(content: string, heading: string, body: string): string {
  const lines = content.split("\n");
  const startIdx = lines.findIndex((l) => l.trim() === heading);
  const block = `${heading}\n\n${body.trim()}`;

  if (startIdx === -1) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", ...block.split("\n"), "");
    return lines.join("\n");
  }

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^## [^#]/.test(t) || t === "^contents") {
      endIdx = i;
      break;
    }
  }
  while (endIdx > startIdx + 1 && lines[endIdx - 1].trim() === "") endIdx--;

  const newLines = [...lines.slice(0, startIdx), ...block.split("\n"), "", ...lines.slice(endIdx)];
  return newLines.join("\n").replace(/\n{3,}/g, "\n\n");
}
