/**
 * conformance-cli.test.mjs — the CLI's testable core `runConformance`: snapshot
 * → build packs from settings → engine → ratchet vs a baseline → result +
 * report. The thin `main` (argv/env/read/print/exit) is not unit-tested; this
 * pins the wiring.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runConformance } from "../src/conformance/cli.ts";

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "conf-cli-"));
  await mkdir(path.join(root, "Notes"), { recursive: true });
  // an unregistered tag → a vocab finding (no vocab registry configured here, so
  // an empty registry means every tag is unregistered — deterministic)
  await writeFile(path.join(root, "Notes", "A.md"), "---\ntitle: A\ntags:\n  - rogue\n---\nbody\n");
  return root;
}

describe("runConformance", () => {
  test("empty baseline → the note's findings are all NEW and the run fails", async () => {
    const root = await vault();
    try {
      const res = await runConformance({
        root,
        baselineText: "",
        vocabularies: [{ id: "reg", provider: "blueprint", root: "Reg" }], // Reg is empty → 'rogue' unregistered
        schemes: [],
      });
      assert.ok(res.ratchet.newKeys.length >= 1, "at least the unregistered tag is NEW");
      assert.equal(res.ratchet.failed, true);
      assert.equal(res.exitCode, 1);
      assert.ok(res.report.includes("NEW"), "report mentions NEW findings");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("baseline containing the finding → carried, run passes", async () => {
    const root = await vault();
    try {
      // first run to learn the exact keys, then baseline them
      const first = await runConformance({ root, baselineText: "", vocabularies: [{ id: "reg", provider: "blueprint", root: "Reg" }], schemes: [] });
      const baselineText = "```ratchet-baseline\n" + first.rebaseline + "\n```\n";
      const second = await runConformance({ root, baselineText, vocabularies: [{ id: "reg", provider: "blueprint", root: "Reg" }], schemes: [] });
      assert.equal(second.ratchet.newKeys.length, 0, "everything now carried");
      assert.equal(second.ratchet.failed, false);
      assert.equal(second.exitCode, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rebaseline output is the sorted key body for the live findings", async () => {
    const root = await vault();
    try {
      const res = await runConformance({ root, baselineText: "", vocabularies: [{ id: "reg", provider: "blueprint", root: "Reg" }], schemes: [] });
      // every rebaseline line is a 4-field key
      for (const line of res.rebaseline.split("\n").filter(Boolean)) {
        assert.equal(line.split("|").length >= 4, true, `key has >=4 fields: ${line}`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("writeFence", () => {
  test("inserts a body containing $-sequences literally (no String.replace pattern expansion)", async () => {
    const { writeFence } = await import("../src/conformance/cli.ts");
    const note = "prose\n\n```ratchet-baseline\nold|a|b|c\n```\n\nmore\n";
    const body = "vocab_findings|unregistered_tag|Notes/Price $& Deal.md|rogue";
    const out = writeFence(note, body);
    assert.ok(out.includes("Notes/Price $& Deal.md"), "literal $& preserved");
    assert.equal(out.includes("old|a|b|c"), false, "old fence body replaced");
    assert.equal((out.match(/```ratchet-baseline/g) || []).length, 1, "exactly one fence");
  });
  test("appends a fence when the note has none", async () => {
    const { writeFence } = await import("../src/conformance/cli.ts");
    const out = writeFence("# just prose\n", "s|c|t|k");
    assert.ok(out.includes("```ratchet-baseline\ns|c|t|k\n```"));
  });
  test("throws on an opening marker with no complete fence (corrupt baseline) rather than silently no-op", async () => {
    const { writeFence } = await import("../src/conformance/cli.ts");
    assert.throws(() => writeFence("```ratchet-baseline\nunclosed key line\n", "s|c|t|k"), /corrupt|complete fence/);
  });
});

describe("legacyPacks opt-in gate (#103 follow-up)", () => {
  test("legacy packs OFF by default; ON with legacyPacks:true", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const pth = (await import("node:path")).default;
    const { runConformance } = await import("../src/conformance/cli.ts");
    const root = await mkdtemp(pth.join(tmpdir(), "conf-gate2-"));
    try {
      await mkdir(pth.join(root, "N"), { recursive: true });
      await writeFile(pth.join(root, "N", "A.md"), "prose with a semicolon; here\n");
      const off = await runConformance({ root, baselineText: "", vocabularies: [], schemes: [] });
      assert.equal(off.findings.some((f) => f.script === "ste_lint" || f.script === "port_lint" || f.script === "conformance_check"), false, "legacy packs off by default");
      const on = await runConformance({ root, baselineText: "", vocabularies: [], schemes: [], legacyPacks: true });
      assert.equal(on.findings.some((f) => f.script === "ste_lint"), true, "legacy packs on with opt-in");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("baselineMissingRefusal (#116 — a missing baseline must fail loudly)", () => {
  test("missing baseline refuses, naming the path and both escapes", async () => {
    const { baselineMissingRefusal } = await import("../src/conformance/cli.ts");
    const r = baselineMissingRefusal("/vault/Assent/Build/conformance/Conformance baseline.md", false, false);
    assert.ok(r, "expected a refusal");
    assert.match(r, /baseline not found/);
    assert.match(r, /Conformance baseline\.md/);
    assert.match(r, /--baseline=/);
    assert.match(r, /--no-baseline/);
  });

  test("an existing baseline proceeds", async () => {
    const { baselineMissingRefusal } = await import("../src/conformance/cli.ts");
    assert.equal(baselineMissingRefusal("/x", true, false), null);
  });

  test("--no-baseline is the explicit from-zero opt-in, even when missing", async () => {
    const { baselineMissingRefusal } = await import("../src/conformance/cli.ts");
    assert.equal(baselineMissingRefusal("/x", false, true), null);
  });

  test("the refusal is about SILENCE, not about forbidding zero baselines", async () => {
    const { baselineMissingRefusal } = await import("../src/conformance/cli.ts");
    // missing + explicit opt-in => allowed; missing + no opt-in => refused.
    assert.equal(baselineMissingRefusal("/x", false, true), null);
    assert.ok(baselineMissingRefusal("/x", false, false));
  });
});
