// The record-immutability ENFORCEMENT SWITCH lives in the probe adapter
// (obsidian-probe.ts's `record()`), which is normally outside the headless
// test boundary — the adapter imports `obsidian` for `TFile`. That convention
// exists because adapters are thin; this one is not thin any more, it decides
// whether a guard runs at all, and an inverted condition here would disable
// record protection vault-wide while every pure-core test stayed green.
//
// So this file reaches it the same sanctioned way tests/link-healing.test.mjs
// reaches the move handlers: install the obsidian stub, then import the real
// adapter and drive it against a fake app. Nothing is re-implemented — the
// assertions are about the shipped `record()`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installObsidianStub, TFile } from "./obsidian-stub.mjs";

installObsidianStub();

const { obsidianProbe } = await import("../src/kernel/obsidian-probe.ts");

/** A fake app whose one note carries whatever frontmatter the test supplies. */
function appWith(path, frontmatter) {
  const file = new TFile(path);
  return {
    vault: {
      getName: () => "test-vault",
      getAbstractFileByPath: (p) => (p === path ? file : null),
      getMarkdownFiles: () => [file],
    },
    metadataCache: {
      getFileCache: (f) => (f === file ? { frontmatter } : null),
    },
  };
}

const RECORD = "Machinery record/8 Vault-wide events.md";

test("enforcement ON (explicit) — a record: true note reports as a record", () => {
  const probe = obsidianProbe(appWith(RECORD, { record: true }), () => true);
  assert.equal(probe.record(RECORD), true);
});

test("enforcement ON (getter omitted — tests, bare embeds) — still enforced", () => {
  const probe = obsidianProbe(appWith(RECORD, { record: true }));
  assert.equal(
    probe.record(RECORD),
    true,
    "an absent toggle must mean ENFORCED: a build that forgot to wire the setting " +
      "should fail toward protection, never silently unprotect every record"
  );
});

test("enforcement OFF — the flag reads as unknown, which is the fail-open path", () => {
  const probe = obsidianProbe(appWith(RECORD, { record: true }), () => false);
  assert.equal(
    probe.record(RECORD),
    undefined,
    "off must report UNKNOWN rather than false: recordImmutableRefusal only " +
      "refuses on an explicit true, so unknown routes down the already-tested " +
      "fail-open path instead of a second refusal branch"
  );
});

test("the toggle is read PER CALL, so a settings edit lands without a reconnect", () => {
  let enforced = true;
  const probe = obsidianProbe(appWith(RECORD, { record: true }), () => enforced);
  assert.equal(probe.record(RECORD), true);
  enforced = false;
  assert.equal(probe.record(RECORD), undefined);
  enforced = true;
  assert.equal(probe.record(RECORD), true);
});

test("enforcement ON — a note without the flag is not a record", () => {
  const probe = obsidianProbe(appWith("Notes/ordinary.md", { title: "x" }), () => true);
  assert.equal(probe.record("Notes/ordinary.md"), undefined);
});

test("enforcement ON — record: false is not a record", () => {
  const probe = obsidianProbe(appWith(RECORD, { record: false }), () => true);
  assert.equal(probe.record(RECORD), false);
});

test("enforcement ON — the quoted string form still declares a record", () => {
  const probe = obsidianProbe(appWith(RECORD, { record: "true" }), () => true);
  assert.equal(probe.record(RECORD), true);
});

test("a missing file reports unknown in either toggle state", () => {
  for (const enforced of [true, false]) {
    const probe = obsidianProbe(appWith(RECORD, { record: true }), () => enforced);
    assert.equal(probe.record("Nowhere/gone.md"), undefined);
  }
});

test("the toggle gates ONLY record(); rev() is untouched", () => {
  const probe = obsidianProbe(appWith(RECORD, { record: true }), () => false);
  assert.equal(probe.record(RECORD), undefined);
  assert.equal(typeof probe.rev(RECORD), "number", "the journal's revision probe must not be gated");
});
