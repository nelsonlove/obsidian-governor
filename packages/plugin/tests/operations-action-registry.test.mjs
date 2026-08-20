/**
 * operations-action-registry.test.mjs — WP0, Gate 0.
 *
 * The action registry is the canonical owner of what Governor can do. An ACTION
 * is a stable postcondition contract; an OPERATION is one invocation of it; a
 * SURFACE (an MCP tool, an Obsidian command, a pane button, an automation, an
 * internal call) is a door onto an action and never a second semantic owner.
 *
 * This file pins the registry's REFUSALS. They are the load-bearing half: a
 * registry that accepts anything cannot make "every reachable invocation
 * resolves to a registered action" true, and the drift test that enforces the
 * bidirectional inventory is built on top of these rules.
 *
 * The rules come from docs/action-registry.md's "Validation rules" section and
 * from the coding guide's fixed authority rules #15 and #17:
 *
 *   • an id/version collision is a build failure, and /v1 is never redefined
 *     in place;
 *   • a surface binding naming an unregistered action is a build failure —
 *     this is the inverse-inventory direction that catches a tool added
 *     without an action;
 *   • an action with no eligible binding is a build failure — the forward
 *     direction that catches an action whose implementation was deleted;
 *   • an ephemeral observation may never support a proposal, verification, or
 *     admission (D16);
 *   • an authority action may be bound only to a human or Governor-internal
 *     surface — binding one to an agent-reachable surface is refused (this is
 *     the tripwire the acceptance fence relies on); and
 *   • an action may not accept an authoritative identity from its caller.
 *
 * Validation returns a problem LIST rather than throwing on the first fault, so
 * one run reports every defect a build must fix.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createActionRegistry, RESERVED_IDENTITY_INPUTS } from "../src/kernel/operations/registry.ts";

// ── fixtures ─────────────────────────────────────────────────────────────────

/** A minimal well-formed read action. */
function readAction(over = {}) {
  return {
    id: "note.read",
    version: 1,
    title: "Read a note",
    postcondition: "Return the exact current bytes of one visible Markdown note.",
    owner: "core",
    distribution: "public-default",
    modes: ["read"],
    changeClasses: [],
    observations: { defaultCapture: "evidence", supportsProposal: false },
    effects: { direct: [], discovered: "none" },
    authority: { governorOnly: false, automaticAdmission: "never" },
    scope: { argumentKeys: ["path"], resolvesAddresses: true, enumeration: "not-applicable", whenScoped: "available" },
    retention: { operation: "ephemeral" },
    inputs: ["path"],
    native: true,
    ...over,
  };
}

/** A minimal well-formed Governor-only authority action. */
function authorityAction(over = {}) {
  return readAction({
    id: "authority.admit",
    version: 1,
    title: "Admit a verified subject",
    postcondition: "Advance the standing ref to an exact verified subject.",
    modes: ["authority"],
    changeClasses: ["authority"],
    authority: { governorOnly: true, automaticAdmission: "never" },
    distribution: "private",
    retention: { operation: "durable" },
    ...over,
  });
}

function binding(over = {}) {
  return { kind: "mcp", id: "obsidian_read_note", action: "note.read", actionVersion: 1, ...over };
}

/** Register + bind + validate in one step; returns the problem codes. */
function problemsOf(actions, bindings) {
  const registry = createActionRegistry();
  for (const a of actions) registry.register(a);
  for (const b of bindings) registry.bind(b);
  return registry.validate().map((p) => p.code);
}

// ── the happy path, so a refusal below means something ───────────────────────

describe("action registry — a well-formed registry validates clean", () => {
  test("one action with one binding produces no problems", () => {
    assert.deepEqual(problemsOf([readAction()], [binding()]), []);
  });

  test("several surfaces may bind ONE action — that is the point of the registry", () => {
    const problems = problemsOf(
      [readAction()],
      [binding(), binding({ kind: "ui", id: "governor:open-note" }), binding({ kind: "internal", id: "review.loadNote" })]
    );
    assert.deepEqual(problems, []);
  });
});

// ── identity ─────────────────────────────────────────────────────────────────

describe("action registry — identity collisions", () => {
  test("registering the same id+version twice is a collision", () => {
    assert.deepEqual(problemsOf([readAction(), readAction()], [binding()]), ["action_id_collision"]);
  });

  test("the same id at a DIFFERENT version is fine — that is how a contract evolves", () => {
    const v2 = readAction({ version: 2 });
    const problems = problemsOf([readAction(), v2], [binding(), binding({ id: "obsidian_read_note_v2", actionVersion: 2 })]);
    assert.deepEqual(problems, []);
  });
});

// ── the bidirectional inventory, in miniature ────────────────────────────────

describe("action registry — bidirectional coverage", () => {
  test("a binding naming an unregistered action is refused (inverse direction)", () => {
    const problems = problemsOf([readAction()], [binding(), binding({ id: "obsidian_mystery", action: "note.mystery" })]);
    assert.deepEqual(problems, ["binding_unknown_action"]);
  });

  test("a binding naming a registered action at an unregistered VERSION is refused", () => {
    const problems = problemsOf([readAction()], [binding({ actionVersion: 7 })]);
    assert.deepEqual(problems, ["binding_unknown_action_version"]);
  });

  test("an action with no binding at all is refused (forward direction)", () => {
    const problems = problemsOf([readAction(), readAction({ id: "note.orphan" })], [binding()]);
    assert.deepEqual(problems, ["action_unbound"]);
  });

  test("two bindings may not share one surface identity", () => {
    // The refused binding is the SECOND one, so `note.other` is left with no
    // door — and the registry says so. Reporting both is the honest result:
    // fixing the collision is not the whole fix, because the action that lost
    // its binding still needs one.
    const problems = problemsOf([readAction(), readAction({ id: "note.other" })], [binding(), binding({ action: "note.other" })]);
    assert.deepEqual(problems, ["surface_id_collision", "action_unbound"]);
  });
});

// ── D16: ephemeral observations cannot support authority ─────────────────────

describe("action registry — observation durability (D16)", () => {
  test("an ephemeral-capture action may not claim it supports a proposal", () => {
    const problems = problemsOf(
      [readAction({ observations: { defaultCapture: "ephemeral", supportsProposal: true } })],
      [binding()]
    );
    assert.deepEqual(problems, ["ephemeral_supports_proposal"]);
  });

  test("evidence and replayable capture may support a proposal", () => {
    for (const defaultCapture of ["evidence", "replayable"]) {
      const problems = problemsOf([readAction({ observations: { defaultCapture, supportsProposal: true } })], [binding()]);
      assert.deepEqual(problems, [], `capture level ${defaultCapture} should be permitted`);
    }
  });
});

// ── the acceptance fence ─────────────────────────────────────────────────────

describe("action registry — authority actions have no agent-reachable surface", () => {
  for (const kind of ["mcp", "external"]) {
    test(`an authority action bound to a '${kind}' surface is refused`, () => {
      const problems = problemsOf([authorityAction()], [binding({ kind, id: `x_${kind}`, action: "authority.admit" })]);
      assert.deepEqual(problems, ["authority_agent_surface"]);
    });
  }

  test("a Governor-only action bound to a ui or internal surface is permitted", () => {
    for (const kind of ["ui", "internal"]) {
      const problems = problemsOf([authorityAction()], [binding({ kind, id: `x_${kind}`, action: "authority.admit" })]);
      assert.deepEqual(problems, [], `${kind} should be an allowed authority surface`);
    }
  });

  test("an action whose changeClasses include 'authority' must be Governor-only", () => {
    const problems = problemsOf(
      [authorityAction({ authority: { governorOnly: false, automaticAdmission: "never" } })],
      [binding({ kind: "ui", id: "x_ui", action: "authority.admit" })]
    );
    assert.deepEqual(problems, ["authority_class_not_governor_only"]);
  });
});

// ── caller-supplied identity ─────────────────────────────────────────────────

describe("action registry — a caller may not choose an authoritative identity", () => {
  test("the reserved identity input names are non-empty and include the actor/signer family", () => {
    assert.ok(RESERVED_IDENTITY_INPUTS.length > 0);
    for (const key of ["actor", "signer", "verifier", "principal", "standing_ref"]) {
      assert.ok(RESERVED_IDENTITY_INPUTS.includes(key), `${key} must be reserved`);
    }
  });

  for (const key of RESERVED_IDENTITY_INPUTS) {
    test(`declaring '${key}' as an action input is refused`, () => {
      const problems = problemsOf([readAction({ inputs: ["path", key] })], [binding()]);
      assert.deepEqual(problems, ["caller_supplied_identity"]);
    });
  }
});

// ── every problem is reported, not just the first ────────────────────────────

describe("action registry — validation reports every defect in one pass", () => {
  test("two unrelated defects both appear", () => {
    const problems = problemsOf(
      [readAction({ observations: { defaultCapture: "ephemeral", supportsProposal: true } }), readAction({ id: "note.orphan" })],
      [binding()]
    );
    assert.deepEqual(problems.sort(), ["action_unbound", "ephemeral_supports_proposal"]);
  });

  test("a problem names the action or surface it is about", () => {
    const registry = createActionRegistry();
    registry.register(readAction());
    registry.bind(binding());
    registry.bind(binding({ id: "obsidian_mystery", action: "note.mystery" }));
    const [problem] = registry.validate();
    assert.equal(problem.code, "binding_unknown_action");
    assert.match(problem.message, /obsidian_mystery/);
    assert.match(problem.message, /note\.mystery/);
  });
});

// ── the registry is frozen once validated ────────────────────────────────────

describe("action registry — a validated registry is sealed", () => {
  test("registering after validate() throws rather than silently drifting", () => {
    const registry = createActionRegistry();
    registry.register(readAction());
    registry.bind(binding());
    registry.validate();
    assert.throws(() => registry.register(readAction({ id: "note.late" })), /sealed/i);
    assert.throws(() => registry.bind(binding({ id: "late_surface" })), /sealed/i);
  });
});
