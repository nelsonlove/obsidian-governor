// The accept/revert primitives (#83, cycle 2) + the CONTEXT-AWARE accept (#221/#164
// acceptance convergence). Ported from obsidian-stewardship/tests/accept.test.mjs, then
// extended: the pane's Accept is now the ONE accept across both lifecycles —
//
//   proposed  ⇒ conformance-gate check, STAMP the accepted family (via the injected
//               stampAccepted dep = processFrontMatter in production), then advance the
//               baseline from the POST-stamp content (the stamp folds into the snapshot);
//   otherwise ⇒ baseline advance only, note byte-untouched (revising is NEVER stamped).
//
// These are the pure functions the pane's gesture-gated Accept/Revert buttons call —
// headless-testable because accept.ts imports nothing from Obsidian. The gesture GATE itself
// (a synthetic event does NOT reach these) is proven in governance-gesture.test.mjs and
// structurally in governance-module.test.mjs (the buttons are addEventListener-wired and
// gate on isRealGesture).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  acceptNote,
  revertNote,
  silentAdvanceRecord,
  formatLocalMinutes,
  AcceptGateError,
  AcceptFoldError,
} from "../src/kernel/governance/accept.ts";
import { computeQueue } from "../src/kernel/governance/queue.ts";
import { makeFakeWorld } from "./governance-helpers.mjs";

const MINUTES_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

describe("baseline-only accept (no proposed status — byte-identical to the pre-convergence path)", () => {
  test("accept advances the baseline to current and logs", async () => {
    const w = makeFakeWorld({ "A.md": "current agent content" });
    w.seedBaseline("A.md", "old baseline");
    const res = await acceptNote(w.deps, "A.md");
    assert.equal(res.stamped, false);
    assert.equal(w.baselines.get("A.md").content, "current agent content");
    assert.equal(w.baselines.get("A.md").acceptedBy, "test-human");
    assert.equal(w.log.length, 1);
    assert.equal(w.log[0].action, "accept");
    assert.equal(w.log[0].by, "test-human");
  });

  test("accept does NOT stamp (or rewrite) a note without acceptance-status — frontmatter byte-untouched", async () => {
    const w = makeFakeWorld({ "A.md": "---\ntitle: T\n---\nplain body" });
    w.seedBaseline("A.md", "old");
    const res = await acceptNote(w.deps, "A.md");
    assert.equal(res.stamped, false);
    assert.equal(w.notes.get("A.md"), "---\ntitle: T\n---\nplain body"); // untouched
    assert.equal(w.stampCalls.length, 0, "stampAccepted must never be called");
  });

  test("a note with NO frontmatter at all gets baseline-advance only", async () => {
    const w = makeFakeWorld({ "A.md": "plain body no frontmatter" });
    w.seedBaseline("A.md", "old");
    const res = await acceptNote(w.deps, "A.md");
    assert.equal(res.stamped, false);
    assert.equal(w.notes.get("A.md"), "plain body no frontmatter");
    assert.equal(w.stampCalls.length, 0);
  });

  test("acceptance-status: revising is NEVER stamped (withdraw/resubmit first) — baseline only", async () => {
    const content = "---\nacceptance-status: revising\n---\nrevised body";
    const w = makeFakeWorld({ "A.md": content });
    w.seedBaseline("A.md", "---\nacceptance-status: revising\n---\nold");
    const res = await acceptNote(w.deps, "A.md");
    assert.equal(res.stamped, false);
    assert.equal(w.notes.get("A.md"), content, "a revising note must stay byte-untouched");
    assert.equal(w.stampCalls.length, 0);
    assert.equal(w.baselines.get("A.md").content, content, "the baseline still advances");
  });

  test("an already-accepted note is not re-stamped — baseline only", async () => {
    const content = "---\nacceptance-status: accepted\naccepted-by: nelson\naccepted-on: 2026-08-01T09:00\n---\nedited";
    const w = makeFakeWorld({ "A.md": content });
    w.seedBaseline("A.md", "old");
    const res = await acceptNote(w.deps, "A.md");
    assert.equal(res.stamped, false);
    assert.equal(w.notes.get("A.md"), content);
    assert.equal(w.stampCalls.length, 0);
  });
});

describe("context-aware accept: proposed ⇒ stamp + baseline folds the stamp (#221/#164)", () => {
  const proposed = "---\nuid: u-1\nacceptance-status: proposed\n---\nagent body";

  test("proposed + delta accept → stamps the accepted family with the correct keys and minutes precision", async () => {
    const w = makeFakeWorld({ "A.md": proposed });
    w.seedBaseline("A.md", "---\nuid: u-1\nacceptance-status: proposed\n---\nold body");
    const res = await acceptNote(w.deps, "A.md");
    assert.equal(res.stamped, true);
    // The stamp went through the injected stampAccepted dep with the exact fields.
    assert.equal(w.stampCalls.length, 1);
    assert.deepEqual(w.stampCalls[0], { path: "A.md", status: "accepted", by: "test-human", on: "2026-08-09T14:07" });
    // The note on disk carries the full accepted family.
    assert.match(w.notes.get("A.md"), /acceptance-status: accepted/);
    assert.match(w.notes.get("A.md"), /accepted-by: test-human/);
    assert.match(w.notes.get("A.md"), /accepted-on: 2026-08-09T14:07/);
    // Minutes precision — the vault convention. Date-only was a fixed bug: never regress.
    assert.match(w.stampCalls[0].on, MINUTES_RE);
    assert.ok(!/accepted-on: 2026-08-09$/m.test(w.notes.get("A.md")), "accepted-on must NOT be date-only");
    // The baseline captured the POST-stamp content (the fold): byte-equal to the note.
    assert.equal(w.baselines.get("A.md").content, w.notes.get("A.md"));
    assert.equal(w.log[0].stamped, true);
  });

  test("the stamp does NOT re-enter the pending queue (the fold, proven through computeQueue)", async () => {
    const w = makeFakeWorld({ "A.md": proposed });
    w.seedBaseline("A.md", "---\nuid: u-1\nacceptance-status: proposed\n---\nold body");
    await acceptNote(w.deps, "A.md");
    // Recompute the queue exactly as refresh() would: current note bytes, the new baseline,
    // and a journal carrying the ORIGINAL agent write (before the accept's timestamp). The
    // stamp changed the note, but because the baseline holds the post-stamp bytes the note
    // is hash-identical to its baseline ⇒ not pending.
    const queue = computeQueue({
      notes: [{ path: "A.md", content: w.notes.get("A.md") }],
      getBaseline: (p) => w.baselines.get(p) ?? null,
      journal: [
        {
          ts: "2026-08-09T11:00:00.000Z",
          op: "obsidian_write_note",
          target: { path: "A.md" },
          actor: { transport: "mcp", client: "agent-x" },
          outcome: "ok",
        },
      ],
    });
    assert.deepEqual(queue, [], "the accept's own stamp must never surface as a fresh pending change");
  });

  test("proposed with NO delta (Proposed-section accept) also stamps and sets a baseline", async () => {
    const w = makeFakeWorld({ "A.md": proposed });
    w.seedBaseline("A.md", proposed); // current == baseline: no pending delta
    const res = await acceptNote(w.deps, "A.md");
    assert.equal(res.stamped, true);
    assert.match(w.notes.get("A.md"), /acceptance-status: accepted/);
    assert.equal(w.baselines.get("A.md").content, w.notes.get("A.md"), "baseline folds the stamp");
  });

  test("formatLocalMinutes: YYYY-MM-DDTHH:mm, zero-padded, minutes precision", () => {
    assert.equal(formatLocalMinutes(new Date(2026, 0, 5, 9, 7, 58, 999)), "2026-01-05T09:07");
    assert.equal(formatLocalMinutes(new Date(2026, 11, 31, 23, 59)), "2026-12-31T23:59");
    assert.match(formatLocalMinutes(new Date()), MINUTES_RE);
  });
});

describe("the conformance gate (requiredFrontmatterKeys) — refuse means NO partial write", () => {
  const proposed = "---\nuid: u-1\ntitle: A note\nacceptance-status: proposed\n---\nbody";

  test("empty gate (the default) gates nothing — the stamp proceeds", async () => {
    const w = makeFakeWorld({ "A.md": proposed });
    w.seedBaseline("A.md", "old");
    w.deps.requiredFrontmatterKeys = [];
    const res = await acceptNote(w.deps, "A.md");
    assert.equal(res.stamped, true);
  });

  test("gate set + all keys present ⇒ accept proceeds", async () => {
    const w = makeFakeWorld({ "A.md": proposed });
    w.seedBaseline("A.md", "old");
    w.deps.requiredFrontmatterKeys = ["uid", "title"];
    const res = await acceptNote(w.deps, "A.md");
    assert.equal(res.stamped, true);
  });

  test("gate set + a key missing ⇒ AcceptGateError, and NOTHING happened (no stamp, no baseline, no log)", async () => {
    const w = makeFakeWorld({ "A.md": proposed });
    w.seedBaseline("A.md", "old");
    w.deps.requiredFrontmatterKeys = ["uid", "title", "description"];
    await assert.rejects(() => acceptNote(w.deps, "A.md"), (e) => {
      assert.ok(e instanceof AcceptGateError);
      assert.deepEqual(e.missing, ["description"]);
      assert.match(e.message, /description/);
      return true;
    });
    assert.equal(w.stampCalls.length, 0, "no stamp");
    assert.equal(w.notes.get("A.md"), proposed, "note byte-untouched");
    assert.equal(w.baselines.get("A.md").content, "old", "baseline NOT advanced");
    assert.equal(w.log.length, 0, "nothing logged — nothing happened");
  });

  test("a present-but-EMPTY key counts as missing", async () => {
    const w = makeFakeWorld({ "A.md": "---\nuid:\nacceptance-status: proposed\n---\nbody" });
    w.seedBaseline("A.md", "old");
    w.deps.requiredFrontmatterKeys = ["uid"];
    await assert.rejects(() => acceptNote(w.deps, "A.md"), AcceptGateError);
    assert.equal(w.baselines.get("A.md").content, "old");
  });

  test("the gate applies ONLY to proposed notes — a no-status note accepts baseline-only despite the gate", async () => {
    const w = makeFakeWorld({ "A.md": "---\ntitle: T\n---\nbody" });
    w.seedBaseline("A.md", "old");
    w.deps.requiredFrontmatterKeys = ["uid", "description"];
    const res = await acceptNote(w.deps, "A.md");
    assert.equal(res.stamped, false);
    assert.equal(w.baselines.get("A.md").content, "---\ntitle: T\n---\nbody");
  });
});

describe("partial-failure safety: stamp-then-baseline ordering (#221/#164 invariant)", () => {
  const proposed = "---\nacceptance-status: proposed\n---\nbody";

  test("stampAccepted throws ⇒ NO baseline advance, nothing logged", async () => {
    const w = makeFakeWorld({ "A.md": proposed });
    w.seedBaseline("A.md", "old");
    w.deps.stampAccepted = async () => { throw new Error("disk full"); };
    await assert.rejects(() => acceptNote(w.deps, "A.md"), /disk full/);
    assert.equal(w.baselines.get("A.md").content, "old", "baseline must NOT advance when the stamp failed");
    assert.equal(w.log.length, 0);
  });

  test("setBaseline throws AFTER a landed stamp ⇒ stamped note, old baseline — and a retry cannot double-stamp", async () => {
    const w = makeFakeWorld({ "A.md": proposed });
    w.seedBaseline("A.md", "old");
    const realSet = w.deps.store.setBaseline;
    w.deps.store.setBaseline = async () => { throw new Error("store broke"); };
    await assert.rejects(() => acceptNote(w.deps, "A.md"), /store broke/);
    assert.match(w.notes.get("A.md"), /acceptance-status: accepted/, "the stamp landed");
    assert.equal(w.baselines.get("A.md").content, "old", "baseline unchanged");
    assert.equal(w.log.length, 0, "no accept record for a failed accept");
    // Retry: the status is now `accepted`, so the retry takes the advance-only branch —
    // exactly one stamp ever, and the baseline lands on the stamped bytes.
    w.deps.store.setBaseline = realSet;
    const res = await acceptNote(w.deps, "A.md");
    assert.equal(res.stamped, false);
    assert.equal(w.stampCalls.length, 1, "never a second stamp");
    assert.equal(w.baselines.get("A.md").content, w.notes.get("A.md"));
  });

  test("fold verification: a foreign body change during the stamp aborts the baseline advance (fail safe)", async () => {
    const w = makeFakeWorld({ "A.md": proposed });
    w.seedBaseline("A.md", "old");
    const realStamp = w.deps.stampAccepted;
    w.deps.stampAccepted = async (p, fields) => {
      await realStamp(p, fields);
      // A racing write lands between the stamp and the re-read.
      w.notes.set(p, w.notes.get(p) + "\ninjected agent content");
    };
    await assert.rejects(() => acceptNote(w.deps, "A.md"), (e) => {
      assert.ok(e instanceof AcceptFoldError);
      assert.match(e.message, /baseline NOT advanced/);
      return true;
    });
    assert.equal(w.baselines.get("A.md").content, "old", "foreign bytes must never be silently folded");
    assert.equal(w.log.length, 0);
  });

  test("fold verification: a stamp that did not land (status still proposed) aborts the baseline advance", async () => {
    const w = makeFakeWorld({ "A.md": proposed });
    w.seedBaseline("A.md", "old");
    w.deps.stampAccepted = async () => { /* silently does nothing */ };
    await assert.rejects(() => acceptNote(w.deps, "A.md"), AcceptFoldError);
    assert.equal(w.baselines.get("A.md").content, "old");
  });

  test("fold verification: a foreign frontmatter KEY injected during the stamp aborts the baseline advance", async () => {
    const w = makeFakeWorld({ "A.md": proposed });
    w.seedBaseline("A.md", "old");
    const realStamp = w.deps.stampAccepted;
    w.deps.stampAccepted = async (p, fields) => {
      await realStamp(p, fields);
      // A racing frontmatter-only write injects a NEW key between the stamp and the re-read.
      const post = w.notes.get(p).replace("---\nbody", "smuggled: payload\n---\nbody");
      w.notes.set(p, post);
    };
    await assert.rejects(() => acceptNote(w.deps, "A.md"), (e) => {
      assert.ok(e instanceof AcceptFoldError);
      assert.match(e.message, /frontmatter keys differ/);
      return true;
    });
    assert.equal(w.baselines.get("A.md").content, "old", "an injected key must never be silently folded");
  });

  test("fold verification: a pre-existing key REMOVED during the stamp aborts the baseline advance", async () => {
    const withExtra = "---\nuid: u-1\nacceptance-status: proposed\n---\nbody";
    const w = makeFakeWorld({ "A.md": withExtra });
    w.seedBaseline("A.md", "old");
    const realStamp = w.deps.stampAccepted;
    w.deps.stampAccepted = async (p, fields) => {
      await realStamp(p, fields);
      w.notes.set(p, w.notes.get(p).replace("uid: u-1\n", ""));
    };
    await assert.rejects(() => acceptNote(w.deps, "A.md"), AcceptFoldError);
    assert.equal(w.baselines.get("A.md").content, "old");
  });

  test("fold verification: stale accepted-by/accepted-on carried by a re-proposed note do NOT abort (stamp keys are exempt)", async () => {
    // An accepted → revising → proposed round-trip leaves old accepted-by/accepted-on in the
    // frontmatter; the stamp legitimately replaces them. The key-set comparison must exempt
    // the three stamp keys or every re-accept would false-abort.
    const reProposed = "---\nuid: u-1\nacceptance-status: proposed\naccepted-by: nelson\naccepted-on: 2026-08-01T09:00\n---\nbody";
    const w = makeFakeWorld({ "A.md": reProposed });
    w.seedBaseline("A.md", "old");
    const res = await acceptNote(w.deps, "A.md");
    assert.equal(res.stamped, true);
    assert.match(w.notes.get("A.md"), /accepted-by: test-human/);
    assert.equal(w.baselines.get("A.md").content, w.notes.get("A.md"));
  });
});

describe("revert (unchanged by the convergence)", () => {
  test("revert restores baseline content and quarantines the rejected version — never deletes", async () => {
    const w = makeFakeWorld({ "A.md": "rejected agent content" });
    w.seedBaseline("A.md", "the good baseline");
    const res = await revertNote(w.deps, "A.md");
    assert.equal(w.notes.get("A.md"), "the good baseline");
    assert.equal(w.quarantines.size, 1);
    assert.equal([...w.quarantines.values()][0], "rejected agent content");
    assert.equal(res.quarantine, [...w.quarantines.keys()][0]);
    assert.equal(w.log[0].action, "revert");
    assert.equal(w.log[0].quarantine, res.quarantine);
  });

  test("revert throws (does nothing destructive) when there is no baseline", async () => {
    const w = makeFakeWorld({ "A.md": "content" });
    await assert.rejects(() => revertNote(w.deps, "A.md"), /no baseline/);
    assert.equal(w.quarantines.size, 0);
    assert.equal(w.notes.get("A.md"), "content");
  });
});

// D2 — silent baseline advances (the human-edit reconcile path) must be auditable.
test("silentAdvanceRecord builds the audit record for a silent baseline advance", () => {
  const rec = silentAdvanceRecord({
    ts: "2026-08-09T12:00:00.000Z",
    path: "Notes/A.md",
    reason: "human-edit",
    fromHash: "oldhash",
    toHash: "newhash",
  });
  assert.deepEqual(rec, {
    event: "silent-advance",
    ts: "2026-08-09T12:00:00.000Z",
    path: "Notes/A.md",
    reason: "human-edit",
    fromHash: "oldhash",
    toHash: "newhash",
  });
});

test("silentAdvanceRecord records fromHash=null when there was no prior baseline", () => {
  const rec = silentAdvanceRecord({
    ts: "2026-08-09T12:00:00.000Z",
    path: "New.md",
    reason: "human-edit",
    fromHash: null,
    toHash: "h1",
  });
  assert.equal(rec.event, "silent-advance");
  assert.equal(rec.fromHash, null);
  assert.equal(rec.toHash, "h1");
});
