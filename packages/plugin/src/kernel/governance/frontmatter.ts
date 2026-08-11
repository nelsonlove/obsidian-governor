// Lightweight frontmatter split + top-level key extraction for the diff view and
// the acceptance-status stamp. This is deliberately NOT a full YAML parser: for the
// key-by-key diff we only need each top-level key's raw text block, and for stamping
// we only touch scalar keys. Anything we don't understand is preserved verbatim.
//
// Ported from obsidian-stewardship/src/frontmatter.ts as part of the governance
// (Acceptance) module fold (#83). Cycle 1 moved ONLY the non-accept logic; cycle 2
// brings over the acceptance-minting helpers (`stampAcceptance`, `hasAcceptanceStatus`)
// now that the accept gesture folds in under its accept-reachability review.
//
// HARD invariant on `stampAcceptance`: it is the ONE place in the whole system that
// writes `accepted`, and it is reachable ONLY from the accept gesture path
// (governance/accept.ts's `acceptNote`, itself reached only via a real trusted click on
// the review pane's Accept button — see governance/wiring.ts). It is NOT wired to any MCP
// tool, command, plugin/view method, or `app`-walkable object. The tripwire
// (tests/governance-module.test.mjs) asserts it stays unreachable from every such surface.

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

// Does the note carry an `acceptance-status` top-level key?
export function hasAcceptanceStatus(content: string): boolean {
  const { hasFrontmatter, frontmatterText } = parseNote(content);
  if (!hasFrontmatter) return false;
  return frontmatterKeys(frontmatterText).has("acceptance-status");
}

// Stamp acceptance provenance into an existing frontmatter block, in place, only for
// keys the note already declares structurally (acceptance-status must exist; accepted-by
// / accepted-on are added or replaced). Returns the new full note content. If there is no
// acceptance-status key, the content is returned unchanged (we never inject the field —
// stamping is only for notes that opted into the vocabulary).
//
// SECURITY: this is the one function that writes `accepted`. It is pure and reachable ONLY
// from acceptNote (governance/accept.ts) on the human-gesture path; see the file header.
export function stampAcceptance(
  content: string,
  by: string,
  on: string,
): { content: string; stamped: boolean } {
  const parsed = parseNote(content);
  if (!parsed.hasFrontmatter) return { content, stamped: false };
  const keys = frontmatterKeys(parsed.frontmatterText);
  if (!keys.has("acceptance-status")) return { content, stamped: false };

  const lines = parsed.frontmatterText.split("\n");
  const setScalar = (key: string, value: string) => {
    const re = new RegExp(`^${escapeRe(key)}:.*$`);
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s/.test(lines[i]) && re.test(lines[i])) {
        lines[i] = `${key}: ${value}`;
        found = true;
        break;
      }
    }
    if (!found) lines.push(`${key}: ${value}`);
  };
  setScalar("acceptance-status", "accepted");
  setScalar("accepted-by", by);
  setScalar("accepted-on", on);

  const rebuilt = `${FENCE}\n${lines.join("\n")}\n${FENCE}\n${parsed.body}`;
  return { content: rebuilt, stamped: true };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
