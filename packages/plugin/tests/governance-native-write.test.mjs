/**
 * governance-native-write.test.mjs — WP6b-1: the first native mutation and
 * its proposal production.
 *
 * The vertical slice's write half: `note.write@1` bound to
 * `obsidian_write_note`, the class firewall proving the content claim against
 * the actual diff (classification rule 5 — never solely from the
 * declaration), the `content-diff@1` predicate proving the subject describes
 * the actual bytes, and the executor's propose hook turning a completed write
 * into a durable proposal without ever costing the caller their result.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NOTE_WRITE_V1 } from "../src/kernel/operations/actions/note-write.ts";
import { deriveClasses, requireClassesCovered, ClassMismatchError, authorityKeysDiffer, frontmatterUid } from "../src/governor/kernel/proposals/class-firewall.ts";
import { CONTENT_DIFF_V1, createDefaultPredicateRegistry } from "../src/governor/kernel/verification/predicates.ts";
import { buildProposalSubjectFromOperation } from "../src/governor/kernel/proposals/proposal-builder.ts";
import { openProposal } from "../src/governor/kernel/proposals/proposal.ts";
import { createProposalStore } from "../src/governor/kernel/proposals/proposal-store.ts";
import { verifySubject } from "../src/governor/kernel/verification/verify.ts";
import { digestBytes } from "../src/governor/kernel/contracts/digest.ts";
import { createActionRegistry } from "../src/kernel/operations/registry.ts";
import { createOperationExecutor } from "../src/kernel/operations/executor.ts";
import { buildMcpActionRegistry } from "../src/kernel/operations/mcp-registry.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const enc = (s) => new TextEncoder().encode(s);
const T0 = 1_700_000_000_000;

function memoryIo() {
  const lines = [];
  return { lines, appendLine: async (l) => void lines.push(l), readLines: async () => [...lines] };
}

// ── the action contract ──────────────────────────────────────────────────────

describe("note.write@1 — the contract", () => {
  test("native, content-classed, proposal-mutation mode, durable operation record", () => {
    assert.equal(NOTE_WRITE_V1.native, true);
    assert.deepEqual(NOTE_WRITE_V1.changeClasses, ["content"]);
    assert.deepEqual(NOTE_WRITE_V1.modes, ["proposal-mutation"]);
    assert.equal(NOTE_WRITE_V1.retention.operation, "durable-for-mutation");
  });

  test("its observation contract claims nothing — a result envelope supports no proposal", () => {
    assert.equal(NOTE_WRITE_V1.observations.defaultCapture, "ephemeral");
    assert.equal(NOTE_WRITE_V1.observations.supportsProposal, false);
  });

  test("exactly one path-shaped input — the contract that makes pathChanged:false TRUE", () => {
    // The producer hardcodes pathChanged: false, which is correct because
    // this action has ONE path and no destination. Nothing pinned that
    // contract (governor-lead's finding — third literal-true-by-untested-
    // contract in three days): the day someone adds a `to`/`destination`
    // input, the literal silently becomes a lie and a move classifies as
    // content-only. This makes that day a red test instead.
    const pathShaped = NOTE_WRITE_V1.inputs.filter((k) => /path|^to$|dest|target|from/i.test(k));
    assert.deepEqual(pathShaped, ["path"], "one path-shaped input; a destination means a NEW action, not a wider write");
    assert.deepEqual(NOTE_WRITE_V1.scope.argumentKeys, ["path"]);
  });

  test("obsidian_write_note resolves to the native action through the real registry", () => {
    const { registry, problems } = buildMcpActionRegistry([]);
    assert.deepEqual(problems, []);
    const binding = registry.binding("obsidian_write_note");
    assert.equal(binding.action, "note.write");
    assert.equal(binding.actionVersion, 1);
  });
});

// ── the class firewall ───────────────────────────────────────────────────────

describe("class firewall — derived from the diff, never solely from the declaration", () => {
  test("a byte change derives content; identical bytes derive nothing", () => {
    assert.deepEqual(deriveClasses({ baseBytes: enc("a"), proposedBytes: enc("b"), pathChanged: false, touchesAuthorityKeys: false }), ["content"]);
    assert.deepEqual(deriveClasses({ baseBytes: enc("same"), proposedBytes: enc("same"), pathChanged: false, touchesAuthorityKeys: false }), []);
    assert.deepEqual(deriveClasses({ baseBytes: null, proposedBytes: enc("new"), pathChanged: false, touchesAuthorityKeys: false }), ["content"], "a creation is a content change");
  });

  test("path and authority facts derive their classes, in canonical order", () => {
    const derived = deriveClasses({ baseBytes: enc("a"), proposedBytes: enc("b"), pathChanged: true, touchesAuthorityKeys: true });
    assert.deepEqual(derived, ["structural", "content", "authority"]);
  });

  test("NARROWING refuses — the attack is a substantive edit riding a mechanical claim", () => {
    // A formatter declaring presentation over a diff that changes content.
    assert.throws(
      () => requireClassesCovered(["presentation"], ["content"]),
      (e) => e instanceof ClassMismatchError && e.code === "class_mismatch"
    );
    // Structural smuggled under a content-only declaration.
    assert.throws(() => requireClassesCovered(["content"], ["content", "structural"]), ClassMismatchError);
  });

  test("WIDENING passes — a declaration above the derivation buys a stricter path", () => {
    requireClassesCovered(["content"], []); // byte-identical rewrite under a content declaration
    requireClassesCovered(["content", "structural"], ["content"]);
  });
});

// ── the authority-diff and uid helpers ───────────────────────────────────────

describe("authorityKeysDiffer — what the accept guard permits, the firewall still classifies", () => {
  test("REMOVING an accepted key differs — the guard permits removal; standing still changed", () => {
    assert.ok(authorityKeysDiffer("---\naccepted-by: Nelson\n---\nbody", "---\n---\nbody"));
  });

  test("an acceptance-status downgrade differs — deliberately guard-allowed, still authority-class", () => {
    assert.ok(authorityKeysDiffer("---\nacceptance-status: accepted\n---\nx", "---\nacceptance-status: proposed\n---\nx"));
  });

  test("byte-identical preservation does not differ", () => {
    const t = "---\naccepted-by: Nelson\naccepted-on: 2026-01-01\n---\nbody";
    assert.ok(!authorityKeysDiffer(t, t.replace("body", "new body")));
  });

  test("ordinary frontmatter changes do not differ; creation with no authority keys does not differ", () => {
    assert.ok(!authorityKeysDiffer("---\ntitle: a\n---\nx", "---\ntitle: b\n---\nx"));
    assert.ok(!authorityKeysDiffer(null, "---\ntitle: new\n---\nx"));
  });

  test("INTRODUCING an accepted key on a creation differs — belt behind the guard's refusal", () => {
    assert.ok(authorityKeysDiffer(null, "---\naccepted-by: someone\n---\nx"));
  });

  test("case and separator variants are the same key — core's one recognizer", () => {
    assert.ok(authorityKeysDiffer("---\nAccepted_By: Nelson\n---\nx", "---\n---\nx"));
  });
});

describe("frontmatterUid — identity from the exact written bytes", () => {
  test("reads the uid, unquotes it, and answers null honestly", () => {
    assert.equal(frontmatterUid("---\nuid: 0190-abc\n---\nbody"), "0190-abc");
    assert.equal(frontmatterUid('---\nuid: "0190-q"\n---\nx'), "0190-q");
    assert.equal(frontmatterUid("---\ntitle: no uid here\n---\nx"), null);
    assert.equal(frontmatterUid("no frontmatter at all"), null);
    assert.equal(frontmatterUid("---\nuid:\n---\nx"), null, "an empty uid is no uid");
  });
});

// ── the first real predicate ─────────────────────────────────────────────────

describe("content-diff@1 — the subject describes the actual bytes", () => {
  const base = enc("base text\n");
  const proposed = enc("proposed text\n");

  function subjectFor(baseBytes, proposedBytes) {
    return buildProposalSubjectFromOperation({
      vaultId: "v",
      noteId: "n",
      path: "A.md",
      pathSemanticallyRelevant: false,
      base: baseBytes === null ? null : digestBytes(baseBytes),
      proposed: digestBytes(proposedBytes),
      changeClasses: ["content"],
      transformation: { id: "note.write", version: "1" },
      predicates: [{ id: "content-diff", version: "1" }],
      producingOperation: { id: "op", action: "note.write", actionVersion: 1 },
      observations: [],
      sessionId: "s",
      mandateId: null,
    });
  }

  test("matching digests pass, through the real registry and verifySubject", async () => {
    const registry = createDefaultPredicateRegistry();
    const outcome = await verifySubject(registry, subjectFor(base, proposed), { baseBytes: base, proposedBytes: proposed }, T0);
    assert.ok(outcome.passed, outcome.records[0]?.detail);
  });

  test("a drifted proposed digest fails with the specific mismatch", async () => {
    const registry = createDefaultPredicateRegistry();
    const outcome = await verifySubject(registry, subjectFor(base, proposed), { baseBytes: base, proposedBytes: enc("EDITED SINCE") }, T0);
    assert.ok(!outcome.passed);
    assert.match(outcome.records[0].detail, /proposed bytes digest to/);
  });

  test("creation semantics: base null must mean NO base bytes, both directions", async () => {
    const registry = createDefaultPredicateRegistry();
    const creation = subjectFor(null, proposed);
    assert.ok((await verifySubject(registry, creation, { baseBytes: null, proposedBytes: proposed }, T0)).passed);
    assert.ok(!(await verifySubject(registry, creation, { baseBytes: base, proposedBytes: proposed }, T0)).passed, "claiming creation over an existing note fails");
    assert.ok(!(await verifySubject(registry, subjectFor(base, proposed), { baseBytes: null, proposedBytes: proposed }, T0)).passed, "claiming a base with no base bytes fails");
  });
});

// ── the propose hook, through the real executor ──────────────────────────────

describe("proposal production — a completed write becomes a durable proposal", () => {
  function harness({ enabled = true, untracked = false, recordFails = false } = {}) {
    const r = createActionRegistry();
    r.register(NOTE_WRITE_V1);
    r.bind({ kind: "mcp", id: "obsidian_write_note", action: NOTE_WRITE_V1.id, actionVersion: NOTE_WRITE_V1.version });
    r.validate();

    const store = createProposalStore(memoryIo());
    // The server wiring's shape, minus Obsidian: slot set by the "backend",
    // taken exactly once by propose (with the attribution guard), snapshots
    // recorded before the proposal opens, slot cleared on every close.
    let writeFacts = null;
    const recordings = [];
    const record = async (proposalId, path, baseBytes, proposedBytes) => {
      if (recordFails) throw new Error("gitdir on fire");
      if (untracked) return null;
      recordings.push({ proposalId, path, baseBytes, proposedBytes });
      return `refs/governor/proposals/${proposalId}`;
    };
    const executor = createOperationExecutor({
      registry: r,
      actor: () => ({ binding: "c", clientClaim: null }),
      sessionId: () => "sess-1",
      sourcesOf: (req) => (req.inputs?.path ? [req.inputs.path] : []),
      propose: async (operation, _result, sources) => {
        const facts = writeFacts;
        writeFacts = null;
        if (!facts) return;
        if (operation.action.id !== NOTE_WRITE_V1.id) return;
        if (!sources.includes(facts.path)) return;
        if (!enabled) return;
        const dec2 = new TextDecoder();
        const derived = deriveClasses({
          baseBytes: facts.baseBytes,
          proposedBytes: facts.proposedBytes,
          pathChanged: false,
          touchesAuthorityKeys: authorityKeysDiffer(facts.baseBytes === null ? null : dec2.decode(facts.baseBytes), dec2.decode(facts.proposedBytes)),
        });
        requireClassesCovered(NOTE_WRITE_V1.changeClasses, derived);
        if (derived.length === 0) return;
        const subject = buildProposalSubjectFromOperation({
          vaultId: "vault-1",
          noteId: frontmatterUid(dec2.decode(facts.proposedBytes)) ?? `path:${facts.path}`,
          path: facts.path,
          pathSemanticallyRelevant: false,
          base: facts.baseBytes === null ? null : digestBytes(facts.baseBytes),
          proposed: digestBytes(facts.proposedBytes),
          changeClasses: derived,
          transformation: { id: NOTE_WRITE_V1.id, version: "1" },
          predicates: [{ id: "content-diff", version: "1" }],
          producingOperation: { id: operation.id, action: operation.action.id, actionVersion: operation.action.version },
          observations: [],
          sessionId: operation.sessionId ?? "no-session",
          mandateId: null,
        });
        const proposal = openProposal({ subject, sessionId: operation.sessionId ?? "no-session" }, T0);
        const ref = await record(proposal.id, facts.path, facts.baseBytes, facts.proposedBytes);
        if (ref === null) return;
        await store.open({ ...proposal, recordingRef: ref }, T0);
      },
      onClose: () => {
        writeFacts = null;
      },
    });
    const setFacts = (f) => (writeFacts = f);
    return { executor, store, setFacts, recordings };
  }

  const WRITE = { surface: { id: "obsidian_write_note" }, inputs: { path: "A.md", content: "new" } };

  test("a completed write opens a proposal carrying the operation id and real digests", async () => {
    const { executor, store, setFacts } = harness();
    const { operation } = await executor.run(WRITE, async (mark) => {
      mark("attempted");
      setFacts({ path: "A.md", baseBytes: enc("old"), proposedBytes: enc("new"), created: false });
      return { path: "A.md", created: false };
    });
    const pending = await store.pending();
    assert.equal(pending.length, 1);
    const p = pending[0];
    assert.equal(p.subject.producingOperation.id, operation.id, "the proposal names the REAL operation");
    assert.equal(p.subject.proposed.value, digestBytes(enc("new")).value);
    assert.equal(p.subject.base.value, digestBytes(enc("old")).value);
    assert.equal(p.sessionId, "sess-1");
    assert.equal(p.authority, "proposed");
    assert.match(p.recordingRef ?? "", /refs\/governor\/proposals\//, "the proposal carries its recording — admission evidence exists");
  });

  test("no recording, no proposal — an untracked path is ungoverned, never a dead proposal", async () => {
    const { executor, store, setFacts } = harness({ untracked: true });
    await executor.run(WRITE, async (mark) => {
      mark("attempted");
      setFacts({ path: "A.md", baseBytes: enc("old"), proposedBytes: enc("new"), created: false });
      return "ok";
    });
    assert.equal((await store.all()).length, 0);
  });

  test("a recording failure skips the proposal and never costs the write", async () => {
    const { executor, store, setFacts } = harness({ recordFails: true });
    const { result } = await executor.run(WRITE, async (mark) => {
      mark("attempted");
      setFacts({ path: "A.md", baseBytes: enc("old"), proposedBytes: enc("new"), created: false });
      return "written";
    });
    assert.equal(result, "written");
    assert.equal((await store.all()).length, 0);
  });

  test("facts whose path does not match the operation's sources are DROPPED — attribution over production", async () => {
    const { executor, store, setFacts } = harness();
    await executor.run(WRITE, async (mark) => {
      mark("attempted");
      setFacts({ path: "SOMEWHERE-ELSE.md", baseBytes: enc("a"), proposedBytes: enc("b"), created: false });
      return "ok";
    });
    assert.equal((await store.all()).length, 0, "a mis-attributed proposal is worse than none");
  });

  test("an authority-touching diff refuses production — the write stands, the legacy queue governs it", async () => {
    // Removal of accepted keys passes the accept guard (it refuses introduce/
    // change, not removal) — the firewall catches what the guard permits.
    const { executor, store, setFacts } = harness();
    const { result } = await executor.run(WRITE, async (mark) => {
      mark("attempted");
      setFacts({
        path: "A.md",
        baseBytes: enc("---\naccepted-by: Nelson\n---\nbody"),
        proposedBytes: enc("---\n---\nbody"),
        created: false,
      });
      return "ok";
    });
    assert.equal(result, "ok");
    assert.equal((await store.all()).length, 0, "an authority-class diff cannot ride a content declaration");
  });

  test("the uid from the written bytes wins over the (lagging) cache path fallback", async () => {
    const { executor, store, setFacts } = harness();
    await executor.run({ surface: { id: "obsidian_write_note" }, inputs: { path: "New.md", content: "x" } }, async (mark) => {
      mark("attempted");
      setFacts({ path: "New.md", baseBytes: null, proposedBytes: enc("---\nuid: 0190-fresh\n---\nbody"), created: true });
      return "ok";
    });
    const all = await store.all();
    assert.equal(all[0].subject.noteId, "0190-fresh", "a freshly-stamped uid is the identity from the first proposal");
  });

  test("disabled ⇒ no proposal; the write is untouched either way", async () => {
    const { executor, store, setFacts } = harness({ enabled: false });
    const { result } = await executor.run(WRITE, async (mark) => {
      mark("attempted");
      setFacts({ path: "A.md", baseBytes: null, proposedBytes: enc("x"), created: true });
      return "ok";
    });
    assert.equal(result, "ok");
    assert.equal((await store.pending()).length, 0);
  });

  test("a byte-identical rewrite proposes nothing — there is no change to govern", async () => {
    const { executor, store, setFacts } = harness();
    await executor.run(WRITE, async (mark) => {
      mark("attempted");
      setFacts({ path: "A.md", baseBytes: enc("same"), proposedBytes: enc("same"), created: false });
      return "ok";
    });
    assert.equal((await store.pending()).length, 0);
  });

  test("a propose failure never costs the caller — the write stands", async () => {
    const r = createActionRegistry();
    r.register(NOTE_WRITE_V1);
    r.bind({ kind: "mcp", id: "obsidian_write_note", action: NOTE_WRITE_V1.id, actionVersion: NOTE_WRITE_V1.version });
    r.validate();
    const executor = createOperationExecutor({
      registry: r,
      actor: () => ({ binding: "c", clientClaim: null }),
      propose: async () => {
        throw new Error("proposal store on fire");
      },
    });
    const { result, operation } = await executor.run(WRITE, async () => "written");
    assert.equal(result, "written");
    assert.equal(operation.outcome, "completed");
  });

  test("the slot is taken exactly once — a following read cannot inherit a write's facts", async () => {
    const { executor, store, setFacts } = harness();
    setFacts({ path: "A.md", baseBytes: enc("a"), proposedBytes: enc("b"), created: false });
    await executor.run(WRITE, async () => "one");
    await executor.run(WRITE, async () => "two"); // no new facts set
    assert.equal((await store.all()).length, 1, "the second operation produced nothing from stale facts");
  });
});

// ── the production wiring, pinned at the source ──────────────────────────────

describe("wiring pins — the mechanism-exists-but-unwired lesson, again", () => {
  const read = (rel) => fs.readFileSync(path.join(HERE, "..", "src", rel), "utf8");

  test("server.ts wires the slot, the gate, the firewall, and the store", () => {
    const server = read("mcp/server.ts");
    assert.match(server, /new ObsidianBackend\(app, visible, \(facts\) => \{/, "the backend reports write facts");
    assert.match(server, /writeFacts = null; \/\/ taken exactly once/, "the slot is take-once");
    assert.match(server, /historyEnabled !== true \|\| !ctx\.proposals/, "production is gated on the human's setting");
    assert.match(server, /requireClassesCovered\(NOTE_WRITE_V1\.changeClasses, derived\)/, "the firewall runs in production");
    assert.match(server, /ctx\.proposals\.open\(/, "the proposal reaches the durable store");
    assert.match(server, /touchesAuthorityKeys: authorityKeysDiffer\(/, "authority classification is derived from the bytes, never hardcoded");
    assert.match(server, /sources\.includes\(facts\.path\)/, "the attribution guard binds facts to the operation's resolved path");
    assert.match(server, /frontmatterUid\(proposedText\)/, "identity comes from the written bytes before the lagging cache");
    assert.match(server, /onClose: \(\) => \{\s*writeFacts = null;/, "the slot clears on EVERY close, not only completed ones");
  });

  test("server.ts records snapshots BEFORE opening the proposal — no dead proposals", () => {
    const server = read("mcp/server.ts");
    const recordAt = server.indexOf("ctx.proposals.record(");
    const openAt = server.indexOf("ctx.proposals.open(");
    assert.ok(recordAt > 0 && openAt > 0 && recordAt < openAt, "record precedes open in the producer");
    assert.match(server, /if \(recordingRef === null\) return;/, "an out-of-scope or failed recording skips the proposal");
  });

  test("main.ts wires the history repository behind the effective scope", () => {
    const main = read("main.ts");
    assert.match(main, /effectiveScope\(this\.settings\.historyScope, EXCLUDED_PREFIXES\)/, "the composed scope gates recording — the WP4 contract consumed");
    assert.match(main, /openGitRepository\(/, "the real history store is the recording target");
    assert.match(main, /proposalRef\(proposalId\)/, "snapshots land on the proposal's own ref");
  });

  test("main.ts wires the proposal store and the uid lookup", () => {
    const main = read("main.ts");
    assert.match(main, /createProposalStore\(/);
    assert.match(main, /proposals\.jsonl/);
    assert.match(main, /uidOf: \(path: string\)/);
  });

  test("the backend reads base bytes BEFORE the modify", () => {
    const backend = read("mcp/obsidian-backend.ts");
    assert.match(backend, /const baseText = this\.onWriteNote \? await this\.app\.vault\.read\(existing\) : null;\n\s*await this\.app\.vault\.modify/, "base is captured before it is gone");
    assert.match(backend, /reportWrite/, "the hook fires through the never-throws wrapper");
  });
});
