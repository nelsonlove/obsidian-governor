// packs/port.ts — the port_lint rule pack: a faithful TS port of port_lint.py,
// the guard for content ported from other vaults (retired source-vault paths,
// old-vault agent-band addresses, retired tooling). A ported brief that still
// names an old-vault address/path/plugin sends an agent somewhere that no
// longer exists.
//
// Line-oriented over the note's FULL text (frontmatter included, like the
// Python), 1-indexed lines. A line naming a reference as historical
// ("retired"/"tombstone"/"superseded"/…) passes. Each pattern yields at most
// one finding per line (first match, like Python's re.search).
//
// Key mapping (parity with the ratchet's parse_port): (port_lint, <pattern
// name>, <relpath>, <matched token>); the line number + context are display
// only, excluded from the key.

import type { Finding } from "../finding.js";
import type { RulePack, VaultSnapshot } from "../rule-pack.js";

export const PORT_PACK_ID = "port_lint";

const PATTERNS: Array<{ name: string; rx: RegExp }> = [
  { name: "retired source-vault path", rx: /(~|\/Users\/nelson)\/obsidian-(newer|new|old)\b/ },
  { name: "old-vault address", rx: /\b(05\.1[137]|05\.5[01]|03\.98)\b/ },
  { name: "retired tooling", rx: /\b(Templater|Metadata Menu|metadata-menu|Dataview Serializer|Advanced URI|advanced-uri|note_uid_generator)\b/ },
];
const HISTORICAL = /retired|tombstone|superseded|archived|do not reintroduce|uninstalled/i;

export function portPack(): RulePack {
  return {
    id: PORT_PACK_ID,
    run(snapshot: VaultSnapshot): Finding[] {
      const out: Finding[] = [];
      for (const note of snapshot.notes) {
        const text = (note as { text?: string }).text;
        if (typeof text !== "string") continue; // needs raw text; skip if absent
        // Line split. The snapshot normalizes CRLF→LF, so `\n` covers the real
        // cases. Caveat vs Python `str.splitlines()`: that also breaks on \v \f
        // \x1c–\x1e NEL U+2028 U+2029 — absent from the vault (349/349 key
        // parity over the live tree), so not split here; a note containing one
        // could diverge by merging two logical lines (documented, not a blocker).
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (HISTORICAL.test(line)) continue;
          for (const { name, rx } of PATTERNS) {
            const m = rx.exec(line);
            if (m) {
              out.push({
                script: PORT_PACK_ID,
                check: name,
                target: note.path,
                kind: m[0],
                detail: `L${i + 1}: ${line.trim().slice(0, 70)}`,
              });
            }
          }
        }
      }
      return out;
    },
  };
}
