/**
 * governance-settings-tab.test.mjs — the BEHAVIORAL gesture-gating proof for the governance
 * settings-tab surface (full-tab parity with the retired standalone stewardship plugin).
 *
 * The settings tab surfaces adopt-baseline + the auto-accept allowlist THROUGH the exact shared
 * helpers the review pane uses — `wireAdoptButton` and `renderAllowlist` (governance/pane.ts). Both
 * are obsidian-free DOM functions (they touch only an element + a gesture), so they ARE exercisable
 * headlessly against a fake element, unlike the ItemView/plugin wiring around them. Testing them
 * here proves the SETTINGS-TAB controls are gesture-gated, because the settings-tab render
 * (renderGovernanceSettings) builds its controls with these same two functions.
 *
 * The acceptance perimeter under test:
 *   - a forged plain-object click ({isTrusted:true}, not an Event) must NOT adopt / must NOT flip a
 *     class, and the checkbox must revert to its real state;
 *   - a synthesized real-but-untrusted Event (isTrusted forced false) likewise must not;
 *   - only a genuine trusted gesture (a real Event whose isTrusted is true) adopts / flips a class.
 *
 * Node's Event exposes isTrusted as a shadowable prototype getter, so — exactly as the pane's own
 * gesture test does — a RealGestureEvent subclass STANDS IN for a physical click. In the browser
 * the DOM's [LegacyUnforgeable] isTrusted makes that unreachable from renderer-JS; that half is
 * documented reasoning + the deploy-time live reachability walk, not a headless assertion.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installObsidianStub } from "./obsidian-stub.mjs";

installObsidianStub();
const { renderAllowlist, wireAdoptButton, AUTO_ACCEPT_DESC, ADOPT_BASELINE_DESC } = await import(
  "../src/governance/pane.ts"
);

// A test-only stand-in for a genuine user gesture: a real Event whose isTrusted reads true.
class RealGestureEvent extends Event {
  get isTrusted() {
    return true;
  }
}
const gesture = () => new RealGestureEvent("click");
const synthesized = () => new Event("click"); // real Event, isTrusted forced false
const forged = () => ({ isTrusted: true, preventDefault() {} }); // plain object — not an Event

// ── a minimal fake element implementing the Obsidian createDiv/createEl/createSpan helpers ──
// Enough for renderAllowlist / wireAdoptButton to build their DOM and register click listeners; a
// test then dispatches a chosen event object to the captured listener.
class FakeEl {
  constructor(tag = "div") {
    this.tag = tag;
    this.cls = "";
    this.text = "";
    this.type = "";
    this.title = "";
    this.checked = false;
    this.children = [];
    this._listeners = new Map();
  }
  _mk(tag, opts = {}) {
    const el = new FakeEl(tag);
    if (opts.cls) el.cls = opts.cls;
    if (opts.text !== undefined) el.text = opts.text;
    if (opts.type) el.type = opts.type;
    this.children.push(el);
    return el;
  }
  createDiv(opts) { return this._mk("div", opts); }
  createSpan(opts) { return this._mk("span", opts); }
  createEl(tag, opts) { return this._mk(tag, opts); }
  setText(t) { this.text = t; }
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }
  // The forgeable property renderer-JS would try to grab. It MUST stay null — the helpers wire via
  // addEventListener only. The test asserts this after wiring.
  onclick = null;
  async dispatch(type, evt) {
    for (const h of this._listeners.get(type) ?? []) await h(evt);
  }
  // Depth-first search for the first descendant (or self) matching a predicate.
  find(pred) {
    if (pred(this)) return this;
    for (const c of this.children) {
      const hit = c.find(pred);
      if (hit) return hit;
    }
    return null;
  }
  findAll(pred, acc = []) {
    if (pred(this)) acc.push(this);
    for (const c of this.children) c.findAll(pred, acc);
    return acc;
  }
}

// A fake allowlist deps that mirrors the REAL setClassEnabled gate: it refuses unless handed a
// genuine trusted gesture (isRealGesture) — the same discipline wiring.ts's setClassEnabled uses.
// (isRealGesture is re-derived here rather than imported so the test pins the CONTRACT the checkbox
// handler depends on: refuse ⇒ false ⇒ revert.)
function isRealGesture(evt) {
  return evt instanceof Event && evt.isTrusted === true;
}
function fakeAllowlistDeps(initial) {
  const state = new Map(Object.entries(initial));
  const CLASSES = [
    { id: "uid-stamp", railNeutralBecause: "why-uid" },
    { id: "timestamp", railNeutralBecause: "why-ts" },
  ];
  return {
    state,
    authorizedClasses: () => CLASSES,
    isClassEnabled: (id) => state.get(id) === true,
    setClassEnabled: async (id, on, evt) => {
      if (!isRealGesture(evt)) return false; // gesture gate — a forged/synth click cannot flip it
      state.set(id, on);
      return true;
    },
  };
}

describe("AUTO_ACCEPT_DESC / ADOPT_BASELINE_DESC — the fuller, single-sourced copy", () => {
  test("the auto-accept text restores the fuller standalone phrasing", () => {
    assert.match(AUTO_ACCEPT_DESC, /Everything else stays pending for review\./);
    assert.match(AUTO_ACCEPT_DESC, /human setup action — never a command, never agent-invokable\./);
  });
  test("the adopt text is the fuller human-setup-action phrasing", () => {
    assert.match(ADOPT_BASELINE_DESC, /snapshots all current content as the reviewed baseline/);
    assert.match(ADOPT_BASELINE_DESC, /never a command, never agent-invokable\./);
  });
  test("renderAllowlist renders the shared AUTO_ACCEPT_DESC verbatim (one source of truth)", () => {
    const root = new FakeEl();
    renderAllowlist(root, fakeAllowlistDeps({ "uid-stamp": true, timestamp: false }));
    const desc = root.find((e) => e.cls === "governance-allowlist-desc");
    assert.ok(desc, "the allowlist description element is rendered");
    assert.equal(desc.text, AUTO_ACCEPT_DESC, "the settings tab and pane share the identical text");
  });
});

describe("settings-tab auto-accept allowlist — gesture-gated (via the shared renderAllowlist)", () => {
  let root, deps, checkboxes;
  beforeEach(() => {
    root = new FakeEl();
    deps = fakeAllowlistDeps({ "uid-stamp": true, timestamp: false });
    renderAllowlist(root, deps);
    checkboxes = root.findAll((e) => e.tag === "input" && e.type === "checkbox");
  });

  test("renders one gesture-gated checkbox per authorized class, reflecting current state", () => {
    assert.equal(checkboxes.length, 2);
    assert.equal(checkboxes[0].checked, true, "uid-stamp starts enabled");
    assert.equal(checkboxes[1].checked, false, "timestamp starts disabled");
    for (const cb of checkboxes) assert.equal(cb.onclick, null, "checkbox.onclick must stay null (addEventListener only)");
  });

  test("a FORGED plain-object click does NOT flip a class and reverts the checkbox", async () => {
    const cb = checkboxes[1]; // timestamp, currently false
    cb.checked = true; // the browser flips the box before the click event fires
    await cb.dispatch("click", forged());
    assert.equal(deps.state.get("timestamp"), false, "a forged click must not enable the class");
    assert.equal(cb.checked, false, "the checkbox reverts to the real (disabled) state");
  });

  test("a SYNTHESIZED untrusted Event does NOT flip a class and reverts the checkbox", async () => {
    const cb = checkboxes[1];
    cb.checked = true;
    await cb.dispatch("click", synthesized());
    assert.equal(deps.state.get("timestamp"), false, "a synthesized click must not enable the class");
    assert.equal(cb.checked, false, "the checkbox reverts");
  });

  test("a GENUINE trusted gesture flips the class (enable AND disable)", async () => {
    const [uid, ts] = checkboxes;
    // enable timestamp
    ts.checked = true;
    await ts.dispatch("click", gesture());
    assert.equal(deps.state.get("timestamp"), true, "a real gesture enables the class");
    assert.equal(ts.checked, true, "the checkbox stays on (no revert)");
    // disable uid-stamp
    uid.checked = false;
    await uid.dispatch("click", gesture());
    assert.equal(deps.state.get("uid-stamp"), false, "a real gesture disables the class");
    assert.equal(uid.checked, false);
  });
});

describe("settings-tab adopt-baseline — gesture- AND confirmation-gated (via shared wireAdoptButton)", () => {
  function wire() {
    const btn = new FakeEl("button");
    let confirmed = 0;
    let adopted = 0;
    let done = 0;
    wireAdoptButton(
      btn,
      async () => { confirmed++; return true; }, // human confirms
      async () => { adopted++; },
      () => { done++; },
    );
    return { btn, get confirmed() { return confirmed; }, get adopted() { return adopted; }, get done() { return done; } };
  }

  test("the adopt button wires via addEventListener — onclick stays null", () => {
    const { btn } = wire();
    assert.equal(btn.onclick, null, "adopt button must not be forgeable via .onclick");
    assert.ok(btn._listeners.has("click"), "adopt is wired with addEventListener('click')");
  });

  test("a FORGED plain-object click never confirms and never adopts", async () => {
    const w = wire();
    await w.btn.dispatch("click", forged());
    assert.equal(w.confirmed, 0, "a forged arg must not even open the confirm modal");
    assert.equal(w.adopted, 0, "the mass-silence adopt must not run");
    assert.equal(w.done, 0, "onDone must not fire");
  });

  test("a SYNTHESIZED untrusted Event never adopts", async () => {
    const w = wire();
    await w.btn.dispatch("click", synthesized());
    assert.equal(w.adopted, 0, "a synthesized dispatch must not adopt");
    assert.equal(w.done, 0);
  });

  test("a GENUINE gesture with human confirm adopts exactly once and fires onDone", async () => {
    const w = wire();
    await w.btn.dispatch("click", gesture());
    assert.equal(w.confirmed, 1, "the confirm modal opens on a real gesture");
    assert.equal(w.adopted, 1, "adopt runs exactly once");
    assert.equal(w.done, 1, "onDone fires after a confirmed adopt");
  });

  test("a GENUINE gesture where the human DECLINES does not adopt (confirmation gate)", async () => {
    const btn = new FakeEl("button");
    let adopted = 0;
    let done = 0;
    wireAdoptButton(
      btn,
      async () => false, // human clicks Cancel / hits Escape
      async () => { adopted++; },
      () => { done++; },
    );
    await btn.dispatch("click", gesture());
    assert.equal(adopted, 0, "declining the modal must not adopt");
    assert.equal(done, 0, "onDone must not fire when the human declines");
  });
});
