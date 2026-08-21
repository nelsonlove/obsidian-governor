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
import { deriveClasses, requireClassesCovered, ClassMismatchError } from "../src/kernel/governance/proposals/class-firewall.ts";
import { CONTENT_DIFF_V1, createDefaultPredicateRegistry } from "../src/kernel/governance/verification/predicates.ts";
import { buildProposalSubjectFromOperation } from "../src/kernel/governance/proposals/proposal-builder.ts";
import { openProposal } from "../src/kernel/governance/proposals/proposal.ts";
import { createProposalStore } from "../src/kernel/governance/proposals/proposal-store.ts";
import { verifySubject } from "../src/kernel/governance/verification/verify.ts";
import { digestBytes } from "../src/kernel/governance/contracts/digest.ts";
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
  function harness({ enabled = true } = {}) {
    const r = createActionRegistry();
    r.register(NOTE_WRITE_V1);
    r.bind({ kind: "mcp", id: "obsidian_write_note", action: NOTE_WRITE_V1.id, actionVersion: NOTE_WRITE_V1.version });
    r.validate();

    const store = createProposalStore(memoryIo());
    // The server wiring's shape, minus Obsidian: slot set by the "backend",
    // taken exactly once by propose, gated on the setting.
    let writeFacts = null;
    const executor = createOperationExecutor({
      registry: r,
      actor: () => ({ binding: "c", clientClaim: null }),
      sessionId: () => "sess-1",
      propose: async (operation) => {
        const facts = writeFacts;
        writeFacts = null;
        if (!facts) return;
        if (operation.action.id !== NOTE_WRITE_V1.id) return;
        if (!enabled) return;
        const derived = deriveClasses({ baseBytes: facts.baseBytes, proposedBytes: facts.proposedBytes, pathChanged: false, touchesAuthorityKeys: false });
        requireClassesCovered(NOTE_WRITE_V1.changeClasses, derived);
        if (derived.length === 0) return;
        const subject = buildProposalSubjectFromOperation({
          vaultId: "vault-1",
          noteId: `path:${facts.path}`,
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
        await store.open(openProposal({ subject, sessionId: operation.sessionId ?? "no-session" }, T0), T0);
      },
    });
    const setFacts = (f) => (writeFacts = f);
    return { executor, store, setFacts };
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
