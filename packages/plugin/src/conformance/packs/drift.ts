// packs/drift.ts — the drift_audit rule pack: a faithful TS port of
// drift_audit.py's NOTE-ONLY checks (E, F, G).
//
// SCOPE OF THIS PORT (deliberate, see issue #80): drift_audit's checks A, B and
// D read `.obsidian/` plugin config (QuickAdd `data.json`, `community-plugins
// .json`, plugin manifests) and a SECOND root (`ASSENT_VAULT_ROOT`) that the
// conformance snapshot has no seam for. Rather than grow the engine a
// plugin-config source incidentally, this pack ports the checks the existing
// snapshot fully supports; A/B/D follow once that seam is designed. C is
// RETIRED in the Python itself (prints a notice, emits no findings), so there
// is nothing to port. H/I/J are report-only and land with the same seam work.
//
// RATCHET KEYS — E and F are SPECIAL-CASED by the ratchet's `parse_drift` and
// are NOT the generic form. Getting this wrong silently churns the baseline:
//   E → (drift_audit, "E", <uid>,          "dup-uid")   keyed on the uid
//   F → (drift_audit, "F", "uid-coverage", "uid-less")  count-independent
//   G → (drift_audit, "G", <message rest>, "")          generic
// F's message carries a changing count and a 5-note sample, so keying on the
// message would make every new gap a NEW finding; one finding, one stable key.

import type { Finding } from "../finding.js";
import type { RulePack, VaultSnapshot } from "../rule-pack.js";

export const DRIFT_PACK_ID = "drift_audit";

/** The registries root the registry-naming families are walked under. */
const REGISTRIES_ROOT = "00-09 System/00 System management/00.05 Registries for the system";

/** A uid is identity only if it is a real UUID (drift_audit.py UUID_RE). */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The daily-note template's frontmatter is copy payload, not identity — its
 * `uid` is empty on purpose and the real one is minted after the copy. */
const UID_EXEMPT = new Set([`${REGISTRIES_ROOT}/Daily notes/Daily note.template.md`]);

/** drift_audit.py `iter_notes`: governed notes only. */
function inScope(vaultPath: string): boolean {
  if (!vaultPath.endsWith(".md")) return false;
  const parts = vaultPath.split("/");
  if (parts.some((p) => p.startsWith(".") || p === ".trash")) return false;
  if (parts.length && (parts[0].startsWith("_") || parts[0] === "Assent")) return false;
  return true;
}

function basename(vaultPath: string): string {
  const i = vaultPath.lastIndexOf("/");
  return i === -1 ? vaultPath : vaultPath.slice(i + 1);
}

function underRegistries(vaultPath: string): boolean {
  return vaultPath.startsWith(REGISTRIES_ROOT + "/");
}

/** The first `# H1` of a note body (drift_audit.py `first_h1`). */
function firstH1(text: string): string | null {
  const m = text.match(/^# (.+?)\s*$/m);
  return m ? m[1] : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Render a title for the G message the way the Python does. A note with no
 * `title` interpolates Python's `None` — and because G's ratchet key INCLUDES
 * the message text, rendering JS's `undefined` instead would give every
 * title-less registry entry a different key from the one in the accepted
 * baseline, churning them all as NEW. Parity here is a key-stability property,
 * not cosmetics. (Caught by the pinned-root parity diff: 19 of 24 keys.)
 */
function pyTitle(v: string | undefined): string {
  return v === undefined ? "None" : v;
}

export function driftPack(): RulePack {
  return {
    id: DRIFT_PACK_ID,
    run(snapshot: VaultSnapshot): Finding[] {
      const out: Finding[] = [];
      const notes = snapshot.notes.filter((n) => inScope(n.path));
      // G's H1 check needs raw text, which lives on `sources` (frontmatter
      // lives on `notes`) — join by path rather than assume one carries both.
      const textOf = new Map((snapshot.sources ?? []).map((s) => [s.path, s.text]));

      // ── E + F: identity ────────────────────────────────────────────────
      // One pass: a note either carries a real UUID (a home for that uid) or
      // it lacks identity. Mirrors the Python's single loop exactly.
      const uidHomes = new Map<string, string[]>();
      const noIdentity: string[] = [];
      for (const n of notes) {
        if (UID_EXEMPT.has(n.path)) continue;
        const uid = str((n.frontmatter ?? {}).uid);
        if (uid && UUID_RE.test(uid)) {
          const homes = uidHomes.get(uid) ?? [];
          homes.push(n.path);
          uidHomes.set(uid, homes);
        } else {
          noIdentity.push(n.path);
        }
      }
      // E — sorted by uid so a report is a function of the vault, not walk order.
      for (const uid of [...uidHomes.keys()].sort()) {
        const homes = uidHomes.get(uid) as string[];
        if (homes.length > 1) {
          out.push({
            script: DRIFT_PACK_ID,
            check: "E",
            target: uid,
            kind: "dup-uid",
            detail: `uid ${uid} is claimed by ${homes.length} notes: ${homes.join("; ")}`,
          });
        }
      }
      // F — ONE aggregated finding; the count and sample live in the detail,
      // never in the key (see the header note).
      if (noIdentity.length > 0) {
        const sample = noIdentity.slice(0, 5).join("; ");
        const more = noIdentity.length > 5 ? ` (+${noIdentity.length - 5} more)` : "";
        out.push({
          script: DRIFT_PACK_ID,
          check: "F",
          target: "uid-coverage",
          kind: "uid-less",
          detail: `${noIdentity.length} note(s) lack a usable uid — run 'Stamp missing UIDs': ${sample}${more}`,
        });
      }

      // ── G: registry naming self-consistency ────────────────────────────
      // title / filename / H1 must agree. A rename that misses one of the
      // three is silent identity drift.
      const families: Array<{ suffix: string; family: string }> = [
        { suffix: ".action.md", family: "action" },
        { suffix: ".property.md", family: "property" },
        { suffix: ".type.md", family: "type" },
      ];
      for (const { suffix, family } of families) {
        for (const n of notes) {
          if (!underRegistries(n.path) || !n.path.endsWith(suffix)) continue;
          const name = basename(n.path);
          const stem = name.slice(0, -".md".length);
          // The Python's `stem[: -len(suffix) + 3]` — drop the family suffix,
          // keeping the bare key (".action.md" is 10 chars, +3 re-adds ".md").
          const key = stem.slice(0, stem.length - (suffix.length - 3));
          const title = str((n.frontmatter ?? {}).title);
          const h1 = firstH1(textOf.get(n.path) ?? "");
          const wantTitle = family === "property" ? `\`${key}\`` : stem;
          const wantH1 = `\`${key}\``;
          if (title !== wantTitle) {
            out.push({
              script: DRIFT_PACK_ID,
              check: "G",
              target: `${name} title is '${pyTitle(title)}', the filename says '${wantTitle}'`,
              kind: "",
              detail: `${name} title is '${pyTitle(title)}', the filename says '${wantTitle}'`,
            });
          }
          if (family === "action" && h1 && h1 !== wantH1) {
            out.push({
              script: DRIFT_PACK_ID,
              check: "G",
              target: `${name} H1 is '${h1}', the filename says '${wantH1}'`,
              kind: "",
              detail: `${name} H1 is '${h1}', the filename says '${wantH1}'`,
            });
          }
        }
      }
      // Tags nest, so the walk differs: title must equal the filename stem.
      for (const n of notes) {
        if (!underRegistries(n.path) || !n.path.endsWith(".tag.md")) continue;
        const name = basename(n.path);
        const stem = name.slice(0, -".md".length);
        const title = str((n.frontmatter ?? {}).title);
        if (title !== stem) {
          out.push({
            script: DRIFT_PACK_ID,
            check: "G",
            target: `${name} title is '${pyTitle(title)}', the filename says '${stem}'`,
            kind: "",
            detail: `${name} title is '${pyTitle(title)}', the filename says '${stem}'`,
          });
        }
      }

      return out;
    },
  };
}
