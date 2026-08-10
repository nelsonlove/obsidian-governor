// packs/drift.ts — the drift rule pack: a verbatim TypeScript port of
// drift_audit.py, the config-vs-registry drift audit. This is the last of the
// four legacy Python conformance scripts to port; with it the Python rail is
// fully retired.
//
// The audit compares live tool configuration against the vault's registries and
// reports each disagreement. It is observational only. drift_audit.py runs a
// lettered battery of checks A–J; only SOME of them append to its `findings`
// list (the rest merely `print` a report line). The conformance ratchet keys
// ONLY the `findings` entries, so this pack ports exactly the finding-producing
// checks and drops the print-only ones:
//
//   A  QuickAdd command-enabled choices  <->  `.action` `quickadd-choice` surfaces (both directions)   [findings]
//   B  live plugin enablement            <->  the 02.12 plugin-stack note                               [findings]
//   C  RETIRED (print-only notice)                                                                       — dropped
//   D  `.action` user-script/module/template surfaces  <->  filesystem existence                        [findings]
//   E  duplicate note `uid` values                                                                       [findings]
//   F  notes without a usable `uid` (one aggregated finding)                                             [findings]
//   G  registry naming self-consistency (title / filename / H1 agree)                                    [findings]
//   H  tag registration (report-only, derived)                                                           — dropped (print-only)
//   I  band filing (report-only)                                                                         — dropped (print-only)
//   J  category-number collisions on the 00-09 System spine                                             [findings]
//
// C/H/I emit NO ratchet findings in the Python (they `print` and never touch
// `findings`), so porting them would be dead logic — they are intentionally
// dropped, not merged.
//
// Finding key (the ratchet's `parse_drift` normalization, frozen by the live
// `Conformance baseline.md`): each Python finding string is `"{LETTER}: {rest}"`,
// keyed as ("drift_audit", <LETTER>, <rest>, "") — the letter is the `check`,
// the message body is the `target`, and `kind` is EMPTY (so the serialized key
// carries a trailing pipe, e.g. `drift_audit|A|choice 'X' ...|`). The pack id IS
// the `script` field: "drift_audit".

import type { Finding } from "../finding.js";
import type { RulePack, SourceFile, VaultSnapshot } from "../rule-pack.js";
import { firstSegment, hasDotOrTrashSegment, isUnderscoreRoot } from "./legacy-scope.js";

export const DRIFT_PACK_ID = "drift_audit";

/** Registries root (drift_audit.py's FBF) — where `.action`/`.property`/`.type`/
 * `.tag` registry notes live. */
export const DEFAULT_REGISTRIES_ROOT =
  "00-09 System/00 System management/00.05 Registries for the system";
/** The System spine (drift_audit.py's SYS) — J's category-collision scan root. */
const SYS_ROOT = "00-09 System";
/** Where user-script/module surfaces resolve (drift_audit.py's BASE02). */
const BASE02_ROOT = "00-09 System/02 Obsidian/02.03 Artifacts for 02 Obsidian";
/** The plugin-stack note (drift_audit.py's PLUGSTACK). */
const PLUGSTACK_PATH = "00-09 System/02 Obsidian/02.12 Plugin stack.md";

// ── Python-parity string helpers (verbatim regex ports) ───────────────────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** drift_audit.py `fm`: the frontmatter block (between the leading `---\n` and
 * the first `\n---\n`), or "" when the note has no leading frontmatter. */
function fmBlock(text: string): string {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  return m ? m[1] : "";
}

/** drift_audit.py `fm_value`: `^key: (.+)$` over the block, whitespace- then
 * quote-stripped (Python `.strip().strip('"')`), else null. */
function fmValue(block: string, key: string): string | null {
  const m = block.match(new RegExp("^" + escapeRe(key) + ": (.+)$", "m"));
  if (!m) return null;
  // .strip() then .strip('"'): trim whitespace, then remove leading/trailing
  // double-quotes (all consecutive ones, as Python's str.strip(chars) does).
  return m[1].trim().replace(/^"+/, "").replace(/"+$/, "");
}

/** drift_audit.py `first_h1`: the first `^# heading` line (trailing whitespace
 * trimmed), else null. */
function firstH1(text: string): string | null {
  const m = text.match(/^# (.+?)\s*$/m);
  return m ? m[1] : null;
}

/** drift_audit.py `surface`: a `surfaces:`-block sub-key's value(s), inline
 * (`  key: value`) or list (`    - item`) form, else null. `key` is
 * interpolated raw exactly as the Python did (the surface keys carry no regex
 * metacharacters). */
function surface(block: string, key: string): string[] | null {
  let m = block.match(new RegExp("^surfaces:\\n(?:  .+\\n)*?  " + key + ": (.+)$", "m"));
  if (m) return [m[1].trim()];
  m = block.match(new RegExp("^surfaces:\\n(?:  .+\\n)*?  " + key + ":\\n((?:    - .+\\n)+)", "m"));
  if (m) {
    return m[1]
      .trim()
      .split("\n")
      .map((ln) => ln.trim().slice(2).trim());
  }
  return null;
}

/** Python truthiness for a parsed-JSON value — `bool(x)` semantics: false/0/""/
 * null/undefined and EMPTY array/object are falsy (an empty `{}` is falsy in
 * Python, truthy in JS — this bridges the gap; `command` is a boolean in the
 * live data, but the check stays faithful for any shape). */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return Boolean(v);
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** drift_audit.py UID_EXEMPT — the daily-note template's `uid` is empty on
 * purpose (copy payload, not identity), so it is excluded from E/F. */
const UID_EXEMPT = new Set([
  "00-09 System/00 System management/00.05 Registries for the system/Daily notes/Daily note.template.md",
]);
/** drift_audit.py UI_CHOICES — utility choices that drive the UI/editor and
 * carry no `.action` entry; excluded from the A direction-1 finding. */
const UI_CHOICES = new Set(["Reveal slot in Finder", "Convert text to property link"]);

interface RegistryNote {
  name: string; // basename, e.g. "accept.action.md"
  text: string;
}

export function driftPack(): RulePack {
  return {
    id: DRIFT_PACK_ID,
    run(snapshot: VaultSnapshot): Finding[] {
      const out: Finding[] = [];
      // A drift finding is `"{LETTER}: {rest}"` → ("drift_audit", LETTER, rest, "").
      const push = (letter: string, rest: string): void => {
        out.push({ script: DRIFT_PACK_ID, check: letter, target: rest, kind: "", detail: `${letter}: ${rest}` });
      };

      const sources: SourceFile[] = snapshot.sources ?? [];
      const sourceText = new Map(sources.map((s) => [s.path, s.text]));
      // `.exists()` universe — files ∪ dirs (a path exists if it is either).
      const existsSet = new Set<string>([...(snapshot.files ?? []), ...(snapshot.dirs ?? [])]);
      const configByPath = new Map((snapshot.obsidianConfig ?? []).map((c) => [c.path, c.text]));

      // Registry families under FBF (drift_audit.py's `by_suffix`): every note
      // whose name ends with `suffix`, sorted by path (Python `sorted(rglob())`).
      const registryFamily = (suffix: string): RegistryNote[] =>
        sources
          .filter((s) => s.path.startsWith(DEFAULT_REGISTRIES_ROOT + "/") && s.path.endsWith(suffix))
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          .map((s) => ({ name: s.path.split("/").pop() ?? s.path, text: s.text }));

      const actionNotes = registryFamily(".action.md");

      // ── A. QuickAdd command-enabled choices <-> `.action` quickadd-choice ─────
      const qaText = configByPath.get(".obsidian/plugins/quickadd/data.json");
      let qa: { choices?: unknown } | null = null;
      if (qaText !== undefined) {
        try {
          qa = JSON.parse(qaText);
        } catch {
          qa = null;
        }
      }
      // act_surfaces is also consumed by nothing else, but it is built here (as
      // Python does) from the action notes' `quickadd-choice` surfaces.
      const actSurfaces = new Map<string, string>(); // choice -> action filename (last wins, sorted)
      for (const act of actionNotes) {
        for (const ch of surface(fmBlock(act.text), "quickadd-choice") ?? []) actSurfaces.set(ch, act.name);
      }
      if (qa && Array.isArray(qa.choices)) {
        const choices = new Map<string, unknown>(); // command-enabled choice name -> choice (walk order)
        const walkChoices = (cs: unknown[]): void => {
          for (const c of cs) {
            const cc = c as { type?: unknown; choices?: unknown; command?: unknown; name?: unknown };
            if (cc && cc.type === "Multi") walkChoices(Array.isArray(cc.choices) ? cc.choices : []);
            else if (cc && pyTruthy(cc.command)) choices.set(String(cc.name), cc);
          }
        };
        walkChoices(qa.choices);
        for (const name of choices.keys()) {
          if (!actSurfaces.has(name) && !UI_CHOICES.has(name))
            push("A", `choice '${name}' is command-enabled but no .action entry names it`);
        }
        for (const [ch, act] of actSurfaces) {
          if (!choices.has(ch)) push("A", `${act} names choice '${ch}' which does not exist in QuickAdd config`);
        }
      }

      // ── B. live plugin enablement <-> the 02.12 plugin-stack note ─────────────
      const plugstack = sourceText.get(PLUGSTACK_PATH);
      if (plugstack !== undefined) {
        const cpText = configByPath.get(".obsidian/community-plugins.json");
        let enabled = new Set<string>();
        if (cpText !== undefined) {
          try {
            const arr = JSON.parse(cpText);
            if (Array.isArray(arr)) enabled = new Set(arr.map(String));
          } catch {
            /* unreadable — treat as none enabled */
          }
        }
        const idToName = new Map<string, string>();
        for (const cfg of snapshot.obsidianConfig ?? []) {
          if (!/^\.obsidian\/plugins\/[^/]+\/manifest\.json$/.test(cfg.path)) continue;
          try {
            const m = JSON.parse(cfg.text);
            if (m && m.id !== undefined) idToName.set(String(m.id), String(m.name));
          } catch {
            /* skip bad manifest, exactly as Python's try/except pass */
          }
        }
        const nameStatus = new Map<string, boolean>();
        for (const [id, name] of idToName) nameStatus.set(name, enabled.has(id));

        const unlink = (s: string): string => s.replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, "$1");
        const listed = new Set<string>();
        for (const rowMatch of plugstack.matchAll(/^\| ([^|]+?) \| ([^|]+?) \|/gm)) {
          const name = unlink(rowMatch[1]).trim();
          // Python `s.strip().strip("*")`: trim whitespace, then strip `*` ends.
          const status = rowMatch[2].trim().replace(/^\*+/, "").replace(/\*+$/, "");
          if (name === "Plugin" || name === "---" || name === ":---") continue;
          listed.add(name);
          const docEnabled = status.startsWith("enabled");
          const docGone = status.includes("uninstalled");
          if (!nameStatus.has(name)) {
            if (!docGone) push("B", `02.12 lists '${name}' (${status}) but no such plugin is installed`);
            continue;
          }
          if (docGone) push("B", `02.12 says '${name}' uninstalled but it is installed`);
          else if (nameStatus.get(name) !== docEnabled) {
            const actual = nameStatus.get(name) ? "enabled" : "disabled";
            push("B", `'${name}' is ${actual} but 02.12 says ${status}`);
          }
        }
        for (const [name, isOn] of [...nameStatus].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
          if (!listed.has(name))
            push("B", `installed plugin '${name}' (${isOn ? "enabled" : "disabled"}) missing from 02.12`);
        }
      }

      // ── D. action surfaces (user-script / module / template) <-> filesystem ───
      for (const act of actionNotes) {
        const block = fmBlock(act.text);
        for (const s of surface(block, "user-script") ?? []) {
          const target = BASE02_ROOT + "/" + s;
          if (!existsSet.has(target)) {
            push("D", `${act.name} names user-script '${s}' which does not exist`);
            continue;
          }
          if (s.endsWith(".md")) {
            const txt = sourceText.get(target);
            if (txt !== undefined && !txt.includes("```js"))
              push("D", `${act.name} user-script '${s}' has no fenced js block`);
          }
        }
        for (const s of surface(block, "module") ?? []) {
          if (!existsSet.has(BASE02_ROOT + "/" + s)) push("D", `${act.name} names module '${s}' which does not exist`);
        }
        for (const s of surface(block, "template") ?? []) {
          if (!existsSet.has(s)) push("D", `${act.name} names template '${s}' which does not exist`);
        }
      }

      // ── E / F. uid identity, over drift_audit.py's `iter_notes` scope in raw
      // TRAVERSAL ORDER (the sample/homes order is part of the finding key). ────
      const governed = (snapshot.walkOrder ?? []).filter(
        (p) => !hasDotOrTrashSegment(p) && !isUnderscoreRoot(p) && firstSegment(p) !== "Assent",
      );
      const uidHomes = new Map<string, string[]>();
      const noIdentity: string[] = [];
      for (const rel of governed) {
        if (UID_EXEMPT.has(rel)) continue;
        const text = sourceText.get(rel);
        if (text === undefined) continue; // Python: `try: block = fm(note) except: continue`
        const uid = fmValue(fmBlock(text), "uid");
        if (uid && UUID_RE.test(uid)) {
          const homes = uidHomes.get(uid);
          if (homes) homes.push(rel);
          else uidHomes.set(uid, [rel]);
        } else {
          noIdentity.push(rel);
        }
      }
      // E — sorted by uid; homes stay in traversal order.
      for (const uid of [...uidHomes.keys()].sort()) {
        const homes = uidHomes.get(uid)!;
        if (homes.length > 1) push("E", `uid ${uid} is claimed by ${homes.length} notes: ` + homes.join("; "));
      }
      // F — one aggregated finding; the sample is the first 5 in traversal order.
      if (noIdentity.length) {
        const sample = noIdentity.slice(0, 5).join("; ");
        const more = noIdentity.length > 5 ? ` (+${noIdentity.length - 5} more)` : "";
        push("F", `${noIdentity.length} note(s) lack a usable uid — run 'Stamp missing UIDs': ${sample}${more}`);
      }

      // ── G. registry naming self-consistency (title / filename / H1) ───────────
      for (const [suffix, family] of [
        [".action.md", "action"],
        [".property.md", "property"],
        [".type.md", "type"],
      ] as const) {
        for (const note of registryFamily(suffix)) {
          const stem = note.name.slice(0, -".md".length);
          const key = stem.slice(0, stem.length - suffix.length + 3); // Python stem[:-len(suffix)+3]
          const title = fmValue(fmBlock(note.text), "title");
          const h1 = firstH1(note.text);
          const wantTitle = family === "property" ? "`" + key + "`" : stem;
          const wantH1 = "`" + key + "`";
          if (title !== wantTitle)
            push("G", `${note.name} title is '${title ?? "None"}', the filename says '${wantTitle}'`);
          if (family === "action" && h1 && h1 !== wantH1)
            push("G", `${note.name} H1 is '${h1}', the filename says '${wantH1}'`);
        }
      }
      // Tags nest, so the walk differs: title must equal the filename stem.
      for (const note of registryFamily(".tag.md")) {
        const stem = note.name.slice(0, -".md".length);
        const title = fmValue(fmBlock(note.text), "title");
        if (title !== stem) push("G", `${note.name} title is '${title ?? "None"}', the filename says '${stem}'`);
      }

      // ── J. category-number collisions on the 00-09 System spine ───────────────
      // drift_audit.py iterates `SYS.iterdir()` (direct children); a two-digit
      // number claimed by more than one folder is a Johnny-Decimal collision.
      const seenCodes = new Map<string, string[]>();
      for (const d of snapshot.dirs ?? []) {
        if (!d.startsWith(SYS_ROOT + "/")) continue;
        const rest = d.slice(SYS_ROOT.length + 1);
        if (rest.includes("/")) continue; // direct children only
        const m = rest.match(/^(\d{2}) /);
        if (!m) continue;
        const list = seenCodes.get(m[1]);
        if (list) list.push(rest);
        else seenCodes.set(m[1], [rest]);
      }
      for (const code of [...seenCodes.keys()].sort()) {
        const names = seenCodes.get(code)!;
        if (names.length > 1)
          push("J", `category number ${code} is claimed by ${names.length} folders: ` + [...names].sort().join("; "));
      }

      return out;
    },
  };
}
