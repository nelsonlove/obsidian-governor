// THE ONE HARD REQUIREMENT for the agent-authored `intent` field: it is UNTRUSTED, agent-authored
// text (up to ~2000 chars) and must reach the DOM as a plain text node ONLY. Ported from
// obsidian-stewardship/tests/intent-view.test.mjs (#83, cycle 2). This drives the actual render
// path (governor/kernel/intent-view.ts, called by governor/wiring/pane.ts) with a fake element tree
// that faithfully mirrors Obsidian's createDiv/createSpan contract (`text` sets `textContent`,
// never `innerHTML`), so the escaping property is proven behaviorally — not just by scanning
// source (pane.ts can't be imported headlessly: it pulls in the types-only `obsidian` runtime).

import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateIntent, renderIntent } from "../src/governor/kernel/intent-view.ts";

// A minimal fake DOM element mirroring the two Obsidian HTMLElement helpers renderIntent uses.
// Setting `text` on creation is the ONLY way this fake accepts content — there is no
// innerHTML-equivalent sink at all, so if renderIntent ever tried to hand it raw HTML there is
// nowhere for that to go except into `.textContent` verbatim, same as the real DOM element.
class FakeEl {
  constructor(tag, opts) {
    this.tag = tag;
    this.cls = opts?.cls;
    this.children = [];
    this._text = opts?.text ?? "";
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join("");
  }
  createDiv(o) { const el = new FakeEl("div", o); this.children.push(el); return el; }
  createSpan(o) { const el = new FakeEl("span", o); this.children.push(el); return el; }
}

const MALICIOUS =
  '<script>alert(1)</script> <b>bold</b> [[wikilink]] {{template}}\nnewline-after-this';

test("renderIntent (full, detail view): raw intent lands in a single text-only span", () => {
  const root = new FakeEl("root");
  renderIntent(root, MALICIOUS, { wrapperCls: "governance-detail-intent", full: true });

  const wrap = root.children[0];
  assert.equal(wrap.tag, "div");
  assert.equal(wrap.cls, "governance-detail-intent");
  assert.equal(wrap.children.length, 2); // label span + text span, nothing else

  const [label, textSpan] = wrap.children;
  assert.equal(label.textContent, "agent says: ");
  assert.equal(label.children.length, 0);

  // The hard requirement: textContent equals the raw intent EXACTLY, and the span parsed no child
  // elements out of it — <script>, <b>, [[wikilink]], {{template}} and the embedded newline all
  // come through as inert characters in one text node.
  assert.equal(textSpan.tag, "span");
  assert.equal(textSpan.children.length, 0);
  assert.equal(textSpan.textContent, MALICIOUS);
  assert.equal(textSpan._text, MALICIOUS);
  assert.equal(wrap.textContent, "agent says: " + MALICIOUS);
});

test("renderIntent (row subtitle, full:false): truncates but still text-only, still literal", () => {
  const root = new FakeEl("root");
  const long = "x".repeat(200) + "<script>evil()</script>";
  renderIntent(root, long, { wrapperCls: "governance-row-intent", full: false });

  const wrap = root.children[0];
  const [, textSpan] = wrap.children;
  assert.equal(textSpan.children.length, 0);
  assert.equal(textSpan.textContent, truncateIntent(long));
  assert.ok(textSpan.textContent.startsWith("x".repeat(140)));
  assert.ok(textSpan.textContent.endsWith("…"));
});

test("renderIntent short malicious string is NOT truncated and stays fully literal", () => {
  const root = new FakeEl("root");
  renderIntent(root, MALICIOUS, { wrapperCls: "governance-row-intent", full: false });
  const [, textSpan] = root.children[0].children;
  assert.equal(textSpan.textContent, MALICIOUS); // under 140 chars: untruncated, still literal
});

test("truncateIntent: no-op under the limit, slices + ellipsis over it", () => {
  assert.equal(truncateIntent("short"), "short");
  const s = "a".repeat(140);
  assert.equal(truncateIntent(s), s); // exactly at the limit: unchanged
  const over = "a".repeat(141);
  assert.equal(truncateIntent(over), "a".repeat(140) + "…");
  assert.equal(truncateIntent("abcdef", 3), "abc…");
});

test("renderIntent never sees a code path that could hand it to an HTML sink", () => {
  const root = new FakeEl("root");
  assert.doesNotThrow(() => renderIntent(root, MALICIOUS, { wrapperCls: "c", full: true }));
});
