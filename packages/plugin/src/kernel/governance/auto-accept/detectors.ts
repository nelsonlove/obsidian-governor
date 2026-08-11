// ============================================================================
//  AUTO-ACCEPT — per-class CONSERVATIVE detectors (pure; no `obsidian` import)
// ----------------------------------------------------------------------------
//  Every function here answers a yes/no about the OBJECTIVE diff (baseline vs
//  current content, plus — for link-heal — a rename index). It reads NOTHING an
//  agent supplies (no journal `intent`, no advisory text): eligibility must be a
//  function of the bytes alone.
//
//  FAIL-SAFE IS THE WHOLE POINT. Every detector returns `ok:false` on ANY doubt:
//  an unexpected added/removed/changed field, an unparseable value, a duplicate
//  key, a body change it cannot fully account for, a missing rename index, or any
//  thrown exception. A `false` means "not provably this class" → the change stays
//  PENDING for a human. A detector must NEVER be optimistic.
//
//  Ported verbatim from obsidian-stewardship/src/auto-accept/detectors.ts (#83, cycle 1).
//  Pure ELIGIBILITY substrate — it computes whether a diff is provably mechanical; it
//  performs no write and is wired to no MCP tool, plugin instance, or `app` this cycle.
// ============================================================================

import { parseNote } from "../frontmatter.js";
import type { ClassId } from "./classes.js";

// ---------------------------------------------------------------------------
//  Value validators — a mechanical field's value must be EXACTLY what the class
//  permits, so nothing else can ride in under a mechanical field name.
// ---------------------------------------------------------------------------

function dequote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// UUIDv7: 8-4-4-4-12 hex, version nibble === 7, variant nibble ∈ {8,9,a,b}.
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isValidUuidV7(value: string): boolean {
  return UUID_V7.test(dequote(value));
}

// A conservative ISO-8601 date or datetime. Strict pattern (not just Date.parse, which accepts
// far too much) so a `created`/`modified` field can never smuggle arbitrary text.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
export function isValidTimestamp(value: string): boolean {
  const v = dequote(value);
  if (!TIMESTAMP.test(v)) return false;
  const t = Date.parse(v);
  return Number.isFinite(t);
}

// ---------------------------------------------------------------------------
//  Frontmatter as an ORDERED list of raw entries. We keep the RAW value text (not
//  trimmed) so any incidental byte change to a field registers as a change (the
//  conservative direction — an incidentally-reformatted note stays pending).
// ---------------------------------------------------------------------------

// `rawLines` holds the EXACT original lines this entry spans (key line + any continuation lines),
// so the parse is byte-LOSSLESS: `leadingLines` ++ every entry's `rawLines`, in order, reproduces
// the input frontmatter verbatim. That losslessness is what lets the completeness check (step 5 in
// evaluateFrontmatter) account for EVERY input line and refuse anything it cannot round-trip.
export interface FmEntry { key: string; value: string; rawLines: string[]; }
export interface FmParse {
  entries: FmEntry[];
  duplicateKey: boolean;
  // Lines appearing BEFORE the first top-level key (a bare/leading line, a comment, whitespace).
  // These are NOT attributable to any entry — a smuggled pre-key line lands here. Never discarded.
  leadingLines: string[];
}

const TOP_LEVEL = /^([A-Za-z0-9_.\- ]+):(.*)$/;

export function parseFrontmatterEntries(fmText: string): FmParse {
  const entries: FmEntry[] = [];
  const seen = new Set<string>();
  const leadingLines: string[] = [];
  let duplicateKey = false;
  if (fmText.length === 0) return { entries, duplicateKey, leadingLines };

  const lines = fmText.split("\n");
  let curKey: string | null = null;
  let curValue: string[] = []; // value tokens (m[2] + raw continuation lines) for value compare
  let curRaw: string[] = [];   // EXACT original lines for this entry (lossless round-trip)
  const flush = () => {
    if (curKey !== null) {
      if (seen.has(curKey)) duplicateKey = true;
      seen.add(curKey);
      entries.push({ key: curKey, value: curValue.join("\n"), rawLines: curRaw });
    }
    curKey = null;
    curValue = [];
    curRaw = [];
  };
  for (const line of lines) {
    const m = TOP_LEVEL.exec(line);
    const indented = /^\s/.test(line);
    if (m && !indented) {
      flush();
      curKey = m[1].trim();
      curValue = [m[2]]; // RAW value text after the colon (leading space kept on purpose)
      curRaw = [line];
    } else if (curKey === null) {
      // A line before the first key — attributable to NO entry. Capture it (NEVER discard) so the
      // completeness check treats it as residual content. This is the fix for the leading-line
      // content-smuggle: previously such a line was buffered and thrown away on the first flush().
      leadingLines.push(line);
    } else {
      curValue.push(line);
      curRaw.push(line);
    }
  }
  flush();
  return { entries, duplicateKey, leadingLines };
}

// ---------------------------------------------------------------------------
//  Frontmatter evaluation — the composition core for the three FM classes.
//  Attributes EVERY frontmatter difference to an ENABLED class, or fails.
// ---------------------------------------------------------------------------

export interface FmEvalResult {
  ok: boolean;
  classes: Set<ClassId>;
  reason: string;
}

const KEY_SEP = " ";

export function evaluateFrontmatter(
  baseFm: string,
  curFm: string,
  enabled: ReadonlySet<ClassId>,
): FmEvalResult {
  const fail = (reason: string): FmEvalResult => ({ ok: false, classes: new Set(), reason });
  const base = parseFrontmatterEntries(baseFm);
  const cur = parseFrontmatterEntries(curFm);
  // Duplicate keys → too ambiguous to reason about; stay pending.
  if (base.duplicateKey || cur.duplicateKey) return fail("duplicate-key");

  const baseMap = new Map(base.entries.map((e) => [e.key, e.value] as const));
  const curMap = new Map(cur.entries.map((e) => [e.key, e.value] as const));
  const classes = new Set<ClassId>();

  // (1) A removed field is NEVER mechanical.
  for (const k of baseMap.keys()) {
    if (!curMap.has(k)) return fail(`field-removed:${k}`);
  }

  // (2) Added fields — only uid (uid-stamp) / created / modified (timestamp), value-validated.
  for (const [k, v] of curMap) {
    if (baseMap.has(k)) continue;
    if (k === "uid" && enabled.has("uid-stamp") && isValidUuidV7(v)) { classes.add("uid-stamp"); continue; }
    if (k === "created" && enabled.has("timestamp") && isValidTimestamp(v)) { classes.add("timestamp"); continue; }
    if (k === "modified" && enabled.has("timestamp") && isValidTimestamp(v)) { classes.add("timestamp"); continue; }
    return fail(`field-added:${k}`);
  }

  // (3) Changed values on common fields — only `modified` may change (to a valid timestamp).
  //     A uid present in both that differs is a uid *change* (never allowed — add-only). A
  //     `created` change is never allowed. Any other field value change → not mechanical.
  for (const [k, bv] of baseMap) {
    const cv = curMap.get(k)!;
    if (cv === bv) continue;
    if (k === "modified" && enabled.has("timestamp") && isValidTimestamp(cv)) { classes.add("timestamp"); continue; }
    return fail(`field-changed:${k}`);
  }

  // (4) Order of the COMMON fields. If their relative order differs, that reordering must be
  //     covered by canonical-order. (Insertions don't count — we compare only common keys.)
  const commonBaseOrder = base.entries.filter((e) => curMap.has(e.key)).map((e) => e.key);
  const commonCurOrder = cur.entries.filter((e) => baseMap.has(e.key)).map((e) => e.key);
  if (commonBaseOrder.join(KEY_SEP) !== commonCurOrder.join(KEY_SEP)) {
    if (!enabled.has("canonical-order")) return fail("reordered");
    classes.add("canonical-order");
  }

  // (5) COMPLETENESS — BYTE-LOSSLESS. Strip the attributed mechanical-field LINES from BOTH sides
  //     and require the remaining frontmatter TEXT to be byte-identical (order-normalized only if
  //     canonical-order matched). Because the parser is lossless — `leadingLines` ++ each entry's
  //     `rawLines` partitions EVERY input line — any line NOT part of a stripped mechanical field
  //     (a smuggled leading/bare line, a comment, stray content, anything the parser couldn't
  //     round-trip into a recognized entry) survives the strip and forces a mismatch → residual →
  //     stay PENDING. This is what closes the leading-line content-smuggle: the injected line is
  //     preserved in `leadingLines` and shows up as a difference here.
  const strip = new Set<string>();
  if (classes.has("uid-stamp")) strip.add("uid");
  if (classes.has("timestamp")) { strip.add("created"); strip.add("modified"); }
  const residualText = (p: FmParse): string => {
    let kept = p.entries.filter((e) => !strip.has(e.key));
    if (classes.has("canonical-order")) {
      // Reorder-only normalization applies to KEYED entries. Leading/unattributable lines are not
      // reorderable content, so they stay verbatim and first — any smuggled pre-key line differs.
      kept = [...kept].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    }
    const out: string[] = [...p.leadingLines];
    for (const e of kept) out.push(...e.rawLines);
    return out.join("\n");
  };
  if (residualText(base) !== residualText(cur)) return fail("residual-frontmatter");

  return { ok: true, classes, reason: "ok" };
}

// ---------------------------------------------------------------------------
//  Link-heal — the ONLY body-changing class. A rename index confirms X→Y.
// ---------------------------------------------------------------------------

// Injected, reliable rename oracle. `confirms(from, to)` is TRUE only when `to` is a CONFIRMED
// rename/move target of `from` (per Obsidian's metadataCache/resolvedLinks or the vault's rename
// records). It MUST be conservative: unknown/unsure → false. It must never throw (the caller
// guards regardless, but a well-behaved index returns false rather than throwing).
export interface RenameIndex {
  confirms(fromTarget: string, toTarget: string): boolean;
}

interface WikiLink { target: string; alias: string | null; raw: string; }

// Split a body into alternating text / wikilink segments. Returns null if the structure can't be
// tokenized safely. A wikilink here is a NON-embed `[[target]]` / `[[target|alias]]` with no
// heading/block ref — anything fancier is left as ordinary text (so a *changed* fancy link falls
// out as a body-text change → not eligible).
const WIKILINK = /\[\[([^\[\]\n]+)\]\]/g;

interface Seg { text: string; link: WikiLink | null; }
function segmentize(body: string): Seg[] {
  const segs: Seg[] = [];
  let last = 0;
  WIKILINK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK.exec(body)) !== null) {
    const inner = m[1];
    // Only simple links participate; heading/block refs and embeds are treated as text.
    const isEmbed = m.index > 0 && body[m.index - 1] === "!";
    const hasRef = inner.includes("#") || inner.includes("^");
    segs.push({ text: body.slice(last, m.index), link: null });
    if (isEmbed || hasRef) {
      segs.push({ text: m[0], link: null }); // keep as literal text
    } else {
      const pipe = inner.indexOf("|");
      const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
      const alias = pipe === -1 ? null : inner.slice(pipe + 1);
      segs.push({ text: "", link: { target, alias, raw: m[0] } });
    }
    last = m.index + m[0].length;
  }
  segs.push({ text: body.slice(last), link: null });
  return segs;
}

export interface BodyEvalResult { ok: boolean; healed: boolean; reason: string; }

// Body is either byte-identical (healed:false, ok:true) or differs ONLY by confirmed link-target
// rewrites (healed:true, ok:true). Anything else → ok:false (stays pending).
export function evaluateLinkHeal(
  baseBody: string,
  curBody: string,
  index: RenameIndex | null | undefined,
): BodyEvalResult {
  if (baseBody === curBody) return { ok: true, healed: false, reason: "body-identical" };
  if (!index) return { ok: false, healed: false, reason: "no-rename-index" };

  let baseSegs: Seg[];
  let curSegs: Seg[];
  try {
    baseSegs = segmentize(baseBody);
    curSegs = segmentize(curBody);
  } catch {
    return { ok: false, healed: false, reason: "segmentize-error" };
  }
  // Structure (count + link-vs-text at each position) must match exactly.
  if (baseSegs.length !== curSegs.length) return { ok: false, healed: false, reason: "structure-changed" };

  let healed = false;
  for (let i = 0; i < baseSegs.length; i++) {
    const b = baseSegs[i];
    const c = curSegs[i];
    const bIsLink = b.link !== null;
    const cIsLink = c.link !== null;
    if (bIsLink !== cIsLink) return { ok: false, healed: false, reason: "structure-changed" };
    if (!bIsLink) {
      // Text segment: must be byte-identical (no smuggled prose).
      if (b.text !== c.text) return { ok: false, healed: false, reason: "body-text-changed" };
      continue;
    }
    const bl = b.link!;
    const cl = c.link!;
    if (bl.raw === cl.raw) continue; // unchanged link
    // A changed link is eligible ONLY as a confirmed target rewrite, alias preserved or dropped.
    const aliasOk = cl.alias === null || cl.alias === bl.alias;
    if (!aliasOk) return { ok: false, healed: false, reason: "alias-changed" };
    let confirmed = false;
    try {
      confirmed = index.confirms(bl.target, cl.target) === true;
    } catch {
      confirmed = false; // an index that throws is treated as "cannot confirm"
    }
    if (!confirmed) return { ok: false, healed: false, reason: "unconfirmed-link" };
    healed = true;
  }
  if (!healed) return { ok: false, healed: false, reason: "body-changed-no-heal" };
  return { ok: true, healed: true, reason: "ok" };
}

// ---------------------------------------------------------------------------
//  Single-class detectors — each answers "is this change EXACTLY and ONLY class
//  X?". Implemented as the composition engine restricted to a one-class allowlist,
//  so there is ONE algorithm and a detector can never diverge from eligibility.
//  (evaluateSingleClass lives here to avoid a cycle with eligibility.ts, which
//  imports these for the public detector API.)
// ---------------------------------------------------------------------------

export interface SingleClassContext { renameIndex?: RenameIndex | null; }

export function detectExactlyClass(
  base: string,
  cur: string,
  cls: ClassId,
  ctx: SingleClassContext = {},
): boolean {
  if (base === cur) return false; // no change is not "this class"
  const enabled = new Set<ClassId>([cls]);
  const bp = parseNote(base);
  const cp = parseNote(cur);

  const body = evaluateLinkHeal(bp.body, cp.body, ctx.renameIndex);
  if (!body.ok) return false;
  const fm = evaluateFrontmatter(bp.frontmatterText, cp.frontmatterText, enabled);
  if (!fm.ok) return false;

  const matched = new Set<ClassId>(fm.classes);
  if (body.healed) matched.add("link-heal");
  // "Exactly and only class X": the sole matched class is X (and there IS a matched class).
  return matched.size === 1 && matched.has(cls);
}

export const detectUidStamp = (base: string, cur: string) => detectExactlyClass(base, cur, "uid-stamp");
export const detectTimestamp = (base: string, cur: string) => detectExactlyClass(base, cur, "timestamp");
export const detectCanonicalOrder = (base: string, cur: string) => detectExactlyClass(base, cur, "canonical-order");
export const detectLinkHeal = (base: string, cur: string, index: RenameIndex | null | undefined) =>
  detectExactlyClass(base, cur, "link-heal", { renameIndex: index });
