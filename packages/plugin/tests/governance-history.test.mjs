// The history browser (#135) — pure builder tests over a synthetic acceptance log (ordering,
// cap, per-note filter, record-kind mapping, tolerance of malformed/unknown records) plus the
// BEHAVIORAL text-node-escaping proof for the renderer (the renderIntent discipline:
// agent-influenced strings — paths, log fields — reach the DOM only as text nodes; the fake
// element has no innerHTML sink at all). Display-only by construction: buildHistory /
// renderHistoryEntries take no callables, return no callables, and mutate nothing — reading the
// log confers nothing. A static scan additionally pins that history.ts holds no accept surface.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHistory,
  toHistoryEntry,
  renderHistoryEntries,
  HISTORY_DEFAULT_CAP,
} from "../src/governor/kernel/history.ts";

const line = (obj) => JSON.stringify(obj);
const ts = (i) => `2026-08-18T10:${String(i).padStart(2, "0")}:00.000Z`;

const SYNTHETIC = [
  { action: "accept", path: "a.md", ts: ts(1), by: "local-human", stamped: false, hash: "h1" },
  { action: "revert", path: "b.md", ts: ts(2), by: "local-human", quarantine: "q/b.md" },
  { event: "silent-advance", ts: ts(3), path: "c.md", reason: "human-edit", fromHash: "f3", toHash: "t3" },
  { event: "auto-accept", reason: "auto-accept", ts: ts(4), path: "a.md", fromHash: "f4", toHash: "t4", classes: ["uid-stamp", "timestamp"], railResult: null },
  { action: "accept", path: "a.md", ts: ts(5), by: "local-human", stamped: true, hash: "h5" },
];
const LOG = SYNTHETIC.map(line).join("\n") + "\n";

describe("buildHistory — ordering, cap, filter, tolerance", () => {
  test("newest first, every record kind mapped", () => {
    const v = buildHistory(LOG);
    assert.equal(v.total, 5);
    assert.equal(v.more, 0);
    assert.deepEqual(
      v.entries.map((e) => e.kind),
      ["accept", "auto-accept", "silent-advance", "revert", "accept"],
    );
    assert.equal(v.entries[0].ts, ts(5));
  });
  test("cap hides older entries and reports +N more (default cap is 200)", () => {
    assert.equal(HISTORY_DEFAULT_CAP, 200);
    const v = buildHistory(LOG, { cap: 2 });
    assert.equal(v.entries.length, 2);
    assert.equal(v.more, 3);
    assert.equal(v.total, 5);
    assert.deepEqual(v.entries.map((e) => e.ts), [ts(5), ts(4)], "the cap keeps the NEWEST entries");
  });
  test("per-note filter keeps only that note's entries (used when opened from a note's detail)", () => {
    const v = buildHistory(LOG, { path: "a.md" });
    assert.deepEqual(v.entries.map((e) => e.ts), [ts(5), ts(4), ts(1)]);
    assert.deepEqual(v.entries.map((e) => e.kind), ["accept", "auto-accept", "accept"]);
    assert.equal(buildHistory(LOG, { path: "nope.md" }).total, 0);
  });
  test("malformed lines are skipped; unknown record shapes surface as 'unknown' (never hidden)", () => {
    const messy = [
      "{not json",
      line({ event: "future-mechanism-record", ts: ts(9), path: "x.md" }),
      "",
      line(SYNTHETIC[0]),
    ].join("\n");
    const v = buildHistory(messy);
    assert.equal(v.total, 2);
    assert.equal(v.entries[0].kind, "unknown");
    assert.equal(v.entries[0].detail, "future-mechanism-record");
  });
  test("detail + hashes carry what each record named (reason / classes / by-whom, from→to)", () => {
    const v = buildHistory(LOG);
    const auto = v.entries.find((e) => e.kind === "auto-accept");
    assert.equal(auto.detail, "classes: uid-stamp, timestamp");
    assert.equal(auto.fromHash, "f4");
    assert.equal(auto.toHash, "t4");
    const silent = v.entries.find((e) => e.kind === "silent-advance");
    assert.equal(silent.detail, "human-edit");
    const accept = v.entries.find((e) => e.ts === ts(1));
    assert.equal(accept.detail, "by local-human");
    assert.equal(accept.toHash, "h1");
  });
  test("toHistoryEntry never throws on hostile field types", () => {
    const e = toHistoryEntry({ event: "auto-accept", classes: { evil: true }, ts: 42, path: null, reason: 7 });
    assert.equal(e.kind, "auto-accept");
    assert.equal(e.path, "");
    assert.equal(typeof e.detail, "string");
  });
  test("#101: the revision-disposition records map to their own kinds (not 'unknown')", () => {
    const req = toHistoryEntry({ action: "request-changes", path: "N.md", ts: "2026-08-18T12:00:00Z", by: "local-human" });
    assert.equal(req.kind, "request-changes");
    assert.equal(req.detail, "by local-human");
    const wd = toHistoryEntry({ action: "withdraw-request", path: "N.md", ts: "2026-08-18T12:01:00Z", by: "local-human" });
    assert.equal(wd.kind, "withdraw-request");
    assert.equal(wd.path, "N.md");
  });
});

// ── the renderer: text nodes ONLY (no innerHTML sink exists in this fake at all) ──
class FakeEl {
  constructor(tag, opts) {
    this.tag = tag;
    this.cls = opts?.cls ?? "";
    this.children = [];
    this._text = opts?.text ?? "";
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join("");
  }
  createDiv(o) { const el = new FakeEl("div", o); this.children.push(el); return el; }
  createSpan(o) { const el = new FakeEl("span", o); this.children.push(el); return el; }
  findAll(pred, acc = []) {
    if (pred(this)) acc.push(this);
    for (const c of this.children) c.findAll(pred, acc);
    return acc;
  }
}

const MALICIOUS_PATH = "<img src=x onerror=alert(1)>/[[wikilink]]/{{template}}.md";

describe("renderHistoryEntries — display-only, text nodes only", () => {
  test("agent-influenced strings land verbatim in text nodes — never parsed into elements", () => {
    const hostileLog = line({
      event: "auto-accept",
      reason: "auto-accept",
      ts: ts(1),
      path: MALICIOUS_PATH,
      fromHash: "<b>f</b>",
      toHash: "t",
      classes: ["<script>alert(1)</script>"],
    });
    const root = new FakeEl("root");
    renderHistoryEntries(root, buildHistory(hostileLog));
    const pathEl = root.findAll((e) => e.cls === "governance-history-path")[0];
    assert.equal(pathEl.children.length, 0, "the path is ONE text node — nothing parsed out of it");
    assert.equal(pathEl._text, MALICIOUS_PATH, "verbatim, inert");
    const detailEl = root.findAll((e) => e.cls === "governance-history-detail")[0];
    assert.equal(detailEl._text, "classes: <script>alert(1)</script>", "hostile class text stays inert");
    // The whole tree consists only of createDiv/createSpan elements. (An innerHTML regression is
    // caught by the missing-span assertions above and by the static HTML-sink scan below — this
    // fake accepts content ONLY via the `text` option, which maps to textContent.)
    for (const el of root.findAll(() => true)) {
      assert.ok(el.tag === "div" || el.tag === "span" || el.tag === "root");
    }
  });
  test("renders newest-first rows with kind, path, detail, hashes, ts — and the +N more marker", () => {
    const root = new FakeEl("root");
    renderHistoryEntries(root, buildHistory(LOG, { cap: 2 }));
    const rows = root.findAll((e) => e.cls.startsWith("governance-history-row"));
    assert.equal(rows.length, 2);
    const more = root.findAll((e) => e.cls === "governance-history-more");
    assert.equal(more.length, 1);
    assert.equal(more[0]._text, "+3 more (older)");
    const kinds = root.findAll((e) => e.cls === "governance-history-kind").map((e) => e._text);
    assert.deepEqual(kinds, ["accepted", "auto-accepted"]);
    const hashes = root.findAll((e) => e.cls === "governance-history-hash").map((e) => e._text);
    assert.deepEqual(hashes, ["∅ → h5", "f4 → t4"]);
  });
  test("empty log renders the empty message", () => {
    const root = new FakeEl("root");
    renderHistoryEntries(root, buildHistory(""));
    assert.equal(root.findAll((e) => e.cls === "governance-empty").length, 1);
  });
  test("a fully-capped view still shows its +N more marker — never masquerades as an empty log", () => {
    const root = new FakeEl("root");
    renderHistoryEntries(root, buildHistory(LOG, { cap: 0 }));
    assert.equal(root.findAll((e) => e.cls === "governance-empty").length, 0);
    const more = root.findAll((e) => e.cls === "governance-history-more");
    assert.equal(more.length, 1);
    assert.equal(more[0]._text, "+5 more (older)");
  });
  test("entries are plain data — NO callables to grab, nothing to invoke", () => {
    const v = buildHistory(LOG);
    for (const e of v.entries) {
      for (const val of Object.values(e)) assert.notEqual(typeof val, "function");
    }
  });
});

// ── static scan: the history module holds NO accept surface and writes nothing ──
test("history.ts references no accept/baseline/log-write capability and imports no obsidian runtime", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs
    .readFileSync(path.join(here, "..", "src", "governor", "kernel", "history.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/([^:])\/\/[^\n]*/g, "$1")
    .replace(/^\/\/[^\n]*/gm, "");
  for (const name of ["setBaseline", "acceptNote", "revertNote", "performAccept", "performAdopt", "appendLog", "stampAcceptedFrontmatter", "adapter"]) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(src), `history.ts must not reference ${name}`);
  }
  assert.ok(!/from\s+["']obsidian["']/.test(src), "history.ts must not import obsidian");
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(src), "history.ts must never touch an HTML sink");
});
