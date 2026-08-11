// Lightweight frontmatter split + top-level key extraction for the diff view.
// This is deliberately NOT a full YAML parser: for the key-by-key diff we only need
// each top-level key's raw text block. Anything we don't understand is preserved verbatim.
//
// Ported from obsidian-stewardship/src/frontmatter.ts as part of the governance
// (Acceptance) module fold (#83, cycle 1). Cycle 1 moves ONLY the non-accept logic:
// the acceptance-minting helpers (`stampAcceptance`, `hasAcceptanceStatus`) are
// DELIBERATELY LEFT BEHIND — they belong with accept.ts, which cycle 2 folds in under
// its own accept-reachability review. Nothing here reads or writes an acceptance field.

export interface ParsedNote {
  hasFrontmatter: boolean;
  frontmatterText: string; // raw text between the --- fences (no fences), "" if none
  body: string;
}

const FENCE = "---";

export function parseNote(content: string): ParsedNote {
  // Frontmatter must start at byte 0 with a `---` line.
  if (!content.startsWith(FENCE)) {
    return { hasFrontmatter: false, frontmatterText: "", body: content };
  }
  // Find the closing fence line.
  const lines = content.split("\n");
  if (lines[0].trim() !== FENCE) {
    return { hasFrontmatter: false, frontmatterText: "", body: content };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FENCE) { close = i; break; }
  }
  if (close === -1) {
    return { hasFrontmatter: false, frontmatterText: "", body: content };
  }
  const frontmatterText = lines.slice(1, close).join("\n");
  const body = lines.slice(close + 1).join("\n");
  return { hasFrontmatter: true, frontmatterText, body };
}

// Extract top-level keys → raw value block (value may span multiple indented lines,
// e.g. a YAML list). Order preserved. Used only for display-diffing frontmatter.
export function frontmatterKeys(frontmatterText: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!frontmatterText.trim()) return out;
  const lines = frontmatterText.split("\n");
  let curKey: string | null = null;
  let curVal: string[] = [];
  const flush = () => {
    if (curKey !== null) out.set(curKey, curVal.join("\n").trim());
    curKey = null;
    curVal = [];
  };
  for (const line of lines) {
    const topLevel = /^([A-Za-z0-9_.\- ]+):(.*)$/.exec(line);
    const indented = /^\s/.test(line);
    if (topLevel && !indented) {
      flush();
      curKey = topLevel[1].trim();
      curVal = [topLevel[2].trim()];
    } else {
      // continuation (indented list item, block scalar, etc.)
      curVal.push(line);
    }
  }
  flush();
  return out;
}
