/**
 * seam.test.mjs — THE GOVERNANCE SEAM (suite split, S2).
 *
 * `src/mcp/seam.ts` is new perimeter surface, and §9 of the design names it as
 * the one place a design error could leak capability. So every rule it claims
 * gets a test that RUNS the path, not a test that reads the source — except
 * where the claim IS about the source (rule 1's "no permission-shaped hook" is
 * a statement about declared return types, and a type has no runtime).
 *
 * What each block pins, and which condition it answers:
 *
 *   registration & revocation   condition 3 — disposer-only, and a caller
 *                               cannot revoke what it did not register
 *   the refusal shape           condition 2 / rule 6 — refusal-shaped, deny
 *                               wins, no expressible allow
 *   observer dispatch           condition 5 — off the caller's result path; a
 *                               hanging or throwing observer costs nothing
 *   the facts                   condition 4 as retriaged — `operation` and
 *                               `actor` deep-frozen, bytes deliberately NOT
 *                               copied
 *   the empty case              rule 4 — a host with no provider
 *   privacy                     condition 1 — the hook LISTS are module-private
 *   provider protection         condition 6 — the plugin tools refuse a
 *                               registered provider's id
 *
 * Every guard here is vacuity-checked: the fixtures are built so that deleting
 * the guard makes the test fail, and the ones where that is not obvious say so
 * in a comment.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createGovernanceSeam, reportCompletedWrite } from "../src/mcp/seam.ts";
import { openSession, expiryRefusal, revokeSession, SESSION_TTL_MS } from "../src/kernel/sessions/session.ts";

const enc = (s) => new TextEncoder().encode(s);

/** A minimal, complete WriteFacts — every field the seam promises to carry. */
function facts(over = {}) {
  return {
    path: "A.md",
    baseBytes: enc("old"),
    proposedBytes: enc("new"),
    operation: { id: "op-1", action: "note.write", actionVersion: 1, sessionId: "s-1" },
    actor: { transport: "mcp", connection: "c-1", server: { vault: "v", install: "i", version: "0" } },
    ...over,
  };
}

/** Let every queued microtask run. Observers are dispatched, never awaited. */
const settle = () => new Promise((r) => setTimeout(r, 0));

// ── registration and revocation (condition 3) ────────────────────────────────

describe("registration and revocation — the disposer is the only address", () => {
  test("a registered observer is called with the write's facts", async () => {
    const { seam, consult } = createGovernanceSeam();
    const seen = [];
    seam.registerWriteObserver("p", (f) => seen.push(f));
    consult.notifyWrite(facts());
    await settle();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, "A.md");
    assert.equal(new TextDecoder().decode(seen[0].proposedBytes), "new");
  });

  test("the disposer removes exactly its own registration, and is idempotent", async () => {
    const { seam, consult } = createGovernanceSeam();
    const a = [], b = [];
    const disposeA = seam.registerWriteObserver("a", (f) => a.push(f));
    seam.registerWriteObserver("b", (f) => b.push(f));
    disposeA();
    disposeA(); // idempotent — a second call must not take B's slot with it
    consult.notifyWrite(facts());
    await settle();
    assert.equal(a.length, 0, "the disposed observer no longer runs");
    assert.equal(b.length, 1, "its neighbour is untouched");
  });

  test("a SPENT disposer cannot drop a later registration by the same id", async () => {
    // The index-splice failure mode: dispose A, register A' under the same id,
    // call the spent disposer again, and a positional or id-keyed
    // implementation removes A'. Identity is what makes this safe.
    const { seam, consult } = createGovernanceSeam();
    const seen = [];
    const disposeFirst = seam.registerWriteObserver("governor", () => {});
    disposeFirst();
    seam.registerWriteObserver("governor", (f) => seen.push(f));
    disposeFirst();
    consult.notifyWrite(facts());
    await settle();
    assert.equal(seen.length, 1, "the replacement survived the stale disposer");
  });

  test("two registrations under the SAME id are told apart by identity, not by label", async () => {
    // The `id` is a LABEL, never an address. If revocation matched on it, one
    // provider registering twice (an observer plus a later reload's observer,
    // or two hooks it wants to drop separately) would find its disposer taking
    // the wrong one — silently, and only under the id collision that a single
    // real provider produces by default.
    const { seam, consult } = createGovernanceSeam();
    const first = [], second = [];
    seam.registerWriteObserver("governor", (f) => first.push(f.path));
    const disposeSecond = seam.registerWriteObserver("governor", (f) => second.push(f.path));
    disposeSecond();
    consult.notifyWrite(facts());
    await settle();
    assert.deepEqual(first, ["A.md"], "the registration nobody disposed still runs");
    assert.deepEqual(second, [], "and the one that was disposed does not");
  });

  test("there is NO id-addressed revocation on either half of the seam", () => {
    // The defect condition 3 names, checked as an absence: an `unregister(id)`
    // is forgeable by anyone holding the api object, and the hooks it would
    // revoke belong to somebody else.
    const { seam, consult } = createGovernanceSeam();
    assert.deepEqual(Object.keys(seam).sort(), ["registerSessionRefusal", "registerWriteObserver"]);
    assert.deepEqual(Object.keys(consult).sort(), ["notifyWrite", "providerIds", "refuseSession"]);
    for (const k of ["unregister", "unregisterHook", "unregisterWriteObserver", "clear", "reset"]) {
      assert.equal(seam[k], undefined, `seam.${k} would be a forgeable revocation address`);
      assert.equal(consult[k], undefined, `consult.${k} would be a forgeable revocation address`);
    }
  });

  test("two seams are independent — a hook registered on one is invisible to the other", async () => {
    const { seam } = createGovernanceSeam();
    const other = createGovernanceSeam();
    const seen = [];
    seam.registerWriteObserver("p", (f) => seen.push(f));
    other.consult.notifyWrite(facts());
    await settle();
    assert.equal(seen.length, 0);
  });

  test("a non-function registration is refused at the door, not at dispatch", () => {
    const { seam } = createGovernanceSeam();
    assert.throws(() => seam.registerWriteObserver("p", null), TypeError);
    assert.throws(() => seam.registerSessionRefusal("p", "not a function"), TypeError);
  });
});

// ── the refusal shape (condition 2, rule 6) ──────────────────────────────────

describe("the session hook is REFUSAL-SHAPED — it cannot express an allow", () => {
  test("a refusal comes back verbatim; null is silence", async () => {
    const { seam, consult } = createGovernanceSeam();
    assert.equal(await consult.refuseSession("s-1"), null, "no hooks, nothing to say");
    const dispose = seam.registerSessionRefusal("p", () => ({ code: "revoked", detail: "a human revoked it" }));
    assert.deepEqual(await consult.refuseSession("s-1"), { code: "revoked", detail: "a human revoked it" });
    dispose();
    assert.equal(await consult.refuseSession("s-1"), null);
  });

  test("DENY WINS: one registrant's refusal stands however many others stay silent", async () => {
    const { seam, consult } = createGovernanceSeam();
    const order = [];
    seam.registerSessionRefusal("quiet-before", () => { order.push("before"); return null; });
    seam.registerSessionRefusal("refuser", () => ({ code: "revoked", detail: "no" }));
    seam.registerSessionRefusal("quiet-after", () => { order.push("after"); return null; });
    assert.deepEqual(await consult.refuseSession("s-1"), { code: "revoked", detail: "no" });
    // And the ones after the refusal are not even consulted — there is nothing
    // they could say that would change the answer, which is the point.
    assert.deepEqual(order, ["before"]);
  });

  test("a registrant CANNOT un-refuse: nothing it returns turns a refusal into a pass", async () => {
    // The pre-amendment shape returned {live: boolean}, so `live: true` was an
    // ALLOW and a later registrant could launder a revoked session through the
    // host's own guarded, journaled path. Every shape that used to mean yes is
    // tried here; all of them are read as silence.
    const { seam, consult } = createGovernanceSeam();
    seam.registerSessionRefusal("refuser", () => ({ code: "revoked", detail: "no" }));
    for (const yes of [true, { live: true }, { allow: true }, { code: null }, undefined, 0, ""]) {
      seam.registerSessionRefusal("optimist", () => yes);
    }
    assert.deepEqual(await consult.refuseSession("s-1"), { code: "revoked", detail: "no" });
  });

  test("a refusal is REDUCED to {code, detail} — a registrant cannot smuggle extra fields", async () => {
    const { seam, consult } = createGovernanceSeam();
    seam.registerSessionRefusal("p", () => ({ code: "revoked", detail: "no", grant: "everything", live: true }));
    assert.deepEqual(await consult.refuseSession("s-1"), { code: "revoked", detail: "no" });
  });

  test("a THROWING refusal hook refuses (rule 2: fail closed)", async () => {
    const { seam, consult } = createGovernanceSeam();
    seam.registerSessionRefusal("broken", () => { throw new Error("store on fire"); });
    const r = await consult.refuseSession("s-1");
    assert.ok(r, "a hook that cannot answer has not said yes");
    assert.equal(r.code, "session_hook_failed");
    assert.match(r.detail, /store on fire/);
    assert.match(r.detail, /broken/, "the failing registrant is named, so the operator can find it");
  });

  test("a REJECTING async refusal hook refuses too", async () => {
    const { seam, consult } = createGovernanceSeam();
    seam.registerSessionRefusal("broken", async () => { throw new Error("timeout"); });
    assert.equal((await consult.refuseSession("s-1")).code, "session_hook_failed");
  });

  test("the sessionId crosses, and null (no session at all) is a legal question", async () => {
    const { seam, consult } = createGovernanceSeam();
    const asked = [];
    seam.registerSessionRefusal("p", (id) => { asked.push(id); return null; });
    await consult.refuseSession("s-9");
    await consult.refuseSession(null);
    assert.deepEqual(asked, ["s-9", null]);
  });

  test("SOURCE: no seam hook declares a boolean or an allow-shaped return", () => {
    // Rule 1/6 is a claim about DECLARED TYPES, which have no runtime, so this
    // is the one pin that must read the source. The instrument is verified
    // against a planted violation below.
    const src = readFileSync(new URL("../src/mcp/seam.ts", import.meta.url), "utf8");
    assert.deepEqual(hookTypeReturns(src), [
      ["SessionRefusalHook", "SeamRefusal | null | Promise<SeamRefusal | null>"],
      ["WriteObserver", "void | Promise<void>"],
    ]);
    // Neither is permission-shaped: one returns nothing the host reads, and the
    // other's only non-null value is a REFUSAL.
    assert.deepEqual(registrationReturns(src), [
      ["registerSessionRefusal", "() => void"],
      ["registerWriteObserver", "() => void"],
    ]);
    // Over CODE only: this module's own header explains the {live: boolean}
    // shape it replaced, and a tripwire that fires on the explanation of why a
    // shape is banned is a tripwire nobody can keep green.
    const code = codeOnly(src);
    assert.ok(!/=>\s*boolean/.test(code), "a boolean-returning hook is a permission predicate");
    assert.ok(!/\blive\s*:\s*boolean/.test(code), "the pre-amendment {live} shape must not come back");
  });
});

/** The module with `//` and block comments removed — prose must not trip a code tripwire. */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every `export type X = (…) => RETURN;` in the module, as [name, return]. */
function hookTypeReturns(src) {
  return [...src.matchAll(/export type (\w+)\s*=\s*\([\s\S]*?\)\s*=>\s*([\s\S]*?);/g)]
    .map((m) => [m[1], m[2].replace(/\s+/g, " ").trim()])
    .sort((x, y) => (x[0] < y[0] ? -1 : 1));
}

/** Every `registerX(…): RETURN;` member declared on an interface, as [name, return]. */
function registrationReturns(src) {
  return [...src.matchAll(/^ {2}(register\w+)\([^\n]*?\):\s*([^\n]+?);$/gm)]
    .map((m) => [m[1], m[2].trim()])
    .sort((x, y) => (x[0] < y[0] ? -1 : 1));
}

describe("the source scan, verified before it is trusted", () => {
  // A scan that silently matches nothing proves nothing, and BOTH extractors
  // here are hand-rolled regexes over a hand-written file — exactly the shape
  // that rots into a no-op. So each is run against a planted violation first.
  const PLANTED = [
    "export type WriteGate = (facts: WriteFacts) => boolean;",
    "",
    "export interface BadSeam {",
    "  registerWriteGate(id: string, gate: WriteGate): void;",
    "}",
  ].join("\n");

  test("it FINDS a planted permission-shaped hook type", () => {
    assert.deepEqual(hookTypeReturns(PLANTED), [["WriteGate", "boolean"]]);
    assert.ok(/=>\s*boolean/.test(PLANTED), "the boolean tripwire fires on a real violation");
  });

  test("it FINDS a planted registration that returns no disposer", () => {
    assert.deepEqual(registrationReturns(PLANTED), [["registerWriteGate", "void"]]);
  });

  test("codeOnly strips prose but keeps declarations", () => {
    const sample = [
      "// as specced it returned {live: boolean}, which was an allow",
      "/* and {live: boolean} again, in a block */",
      "export type WriteObserver = (f: WriteFacts) => void | Promise<void>;",
    ].join("\n");
    assert.ok(/\blive\s*:\s*boolean/.test(sample), "the prose is really there");
    assert.ok(!/\blive\s*:\s*boolean/.test(codeOnly(sample)), "and codeOnly removes it");
    assert.equal(hookTypeReturns(codeOnly(sample)).length, 1, "while the declaration survives");
  });

  test("both extractors find real declarations in the real module", () => {
    const src = readFileSync(new URL("../src/mcp/seam.ts", import.meta.url), "utf8");
    assert.equal(hookTypeReturns(src).length, 2);
    assert.equal(registrationReturns(src).length, 2);
  });
});

// ── observer dispatch (condition 5) ──────────────────────────────────────────

describe("observers cannot cost the caller their write", () => {
  test("a HANGING observer does not delay notifyWrite", async () => {
    const { seam, consult } = createGovernanceSeam();
    let entered = false;
    seam.registerWriteObserver("slow", () => { entered = true; return new Promise(() => {}); });
    const started = Date.now();
    consult.notifyWrite(facts()); // synchronous return, no await anywhere
    assert.ok(Date.now() - started < 50, "notifyWrite returned without waiting");
    await settle();
    assert.equal(entered, true, "and the observer really did run — the test is not vacuous");
  });

  test("an observer does not run SYNCHRONOUSLY — notifyWrite returns before it starts", async () => {
    // Condition 5's actual mechanism. "Not awaited" is not enough on its own:
    // a synchronous call still runs the provider's code inside the caller's
    // stack, so a slow or looping observer spends the caller's time. The
    // dispatch is one microtask per hook, so the write's own path is finished
    // before any provider code runs at all.
    const { seam, consult } = createGovernanceSeam();
    let ran = false;
    seam.registerWriteObserver("p", () => { ran = true; });
    consult.notifyWrite(facts());
    assert.equal(ran, false, "the observer had not started when notifyWrite returned");
    await settle();
    assert.equal(ran, true, "and it really does run — the assertion above is not vacuous");
  });

  test("a THROWING observer does not throw at the caller, and its neighbours still run", async () => {
    const { seam, consult } = createGovernanceSeam();
    const after = [];
    seam.registerWriteObserver("broken", () => { throw new Error("boom"); });
    seam.registerWriteObserver("fine", (f) => after.push(f.path));
    assert.doesNotThrow(() => consult.notifyWrite(facts()));
    await settle();
    assert.deepEqual(after, ["A.md"], "one bad observer does not silence the rest");
  });

  test("a REJECTING async observer is swallowed, not left as an unhandled rejection", async () => {
    const { seam, consult } = createGovernanceSeam();
    let unhandled = null;
    const onUnhandled = (e) => { unhandled = e; };
    process.on("unhandledRejection", onUnhandled);
    try {
      seam.registerWriteObserver("broken", async () => { throw new Error("late boom"); });
      consult.notifyWrite(facts());
      await settle();
      await settle();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    assert.equal(unhandled, null, "the rejection was caught by the dispatcher");
  });

  test("an observer's RETURN VALUE is ignored — it cannot refuse, allow, or rewrite (rule 1)", async () => {
    const { seam, consult } = createGovernanceSeam();
    const other = [];
    seam.registerWriteObserver("opinionated", (f) => {
      try { f.path = "SOMEWHERE-ELSE.md"; } catch { /* frozen */ }
      return { code: "refused", detail: "I object" };
    });
    seam.registerWriteObserver("next", (f) => other.push(f.path));
    const f = facts();
    consult.notifyWrite(f);
    await settle();
    assert.equal(f.path, "A.md", "the facts object is unchanged");
    assert.deepEqual(other, ["A.md"], "and the next observer sees the same facts");
  });
});

// ── the facts (condition 4, as retriaged) ────────────────────────────────────

describe("what crosses: frozen identifiers, shared bytes", () => {
  test("`operation` and `actor` are DEEP-frozen — one hook cannot rewrite what the next reads", async () => {
    const { seam, consult } = createGovernanceSeam();
    const seen = [];
    seam.registerWriteObserver("first", (f) => {
      // Each assignment in its own try, because a frozen target THROWS under
      // ESM strict mode and one throw would leave the other two untried — the
      // test would then pass while pinning only the first freeze. If the freeze
      // were removed, all three would land and the next hook would read
      // "forged", including in `actor`, which is what the host's own journal
      // attribution is made of.
      for (const assign of [
        () => { f.operation.sessionId = "forged"; },
        () => { f.actor.connection = "forged"; },
        () => { f.actor.server.vault = "forged"; },
      ]) {
        try { assign(); } catch { /* frozen, as intended */ }
      }
    });
    seam.registerWriteObserver("second", (f) => seen.push([f.operation.sessionId, f.actor.connection, f.actor.server.vault]));
    consult.notifyWrite(facts());
    await settle();
    assert.deepEqual(seen, [["s-1", "c-1", "v"]]);
  });

  test("the freeze reaches NESTED objects, not just the top level", async () => {
    const { seam, consult } = createGovernanceSeam();
    let frozen = null;
    seam.registerWriteObserver("p", (f) => { frozen = [Object.isFrozen(f), Object.isFrozen(f.operation), Object.isFrozen(f.actor), Object.isFrozen(f.actor.server)]; });
    consult.notifyWrite(facts());
    await settle();
    assert.deepEqual(frozen, [true, true, true, true]);
  });

  test("BYTES ARE NOT COPIED, deliberately — the hook receives the host's own buffer", async () => {
    // Pinned so the decision is visible rather than accidental. §0's retriage
    // DEFERRED per-hook byte copies to `reference/hostile-threat-model`: the
    // only actor a copy defends against is hostile code already running in the
    // renderer, which can read and write the whole vault through `app.vault`
    // anyway, and the copy is a per-write cost on every write. If a future
    // threat model reverses that, this test is where the reversal lands.
    const { seam, consult } = createGovernanceSeam();
    const f = facts();
    let sameBuffer = null;
    seam.registerWriteObserver("p", (got) => { sameBuffer = got.proposedBytes === f.proposedBytes; });
    consult.notifyWrite(f);
    await settle();
    assert.equal(sameBuffer, true);
  });

  test("no capability crosses — the facts carry only data (rule 5)", async () => {
    const { seam, consult } = createGovernanceSeam();
    let received = null;
    seam.registerWriteObserver("p", (f) => { received = f; });
    consult.notifyWrite(facts());
    await settle();
    const functions = [];
    const walk = (v, at, depth) => {
      if (depth > 4 || v === null || typeof v !== "object") return;
      for (const [k, child] of Object.entries(v)) {
        if (typeof child === "function") functions.push(`${at}.${k}`);
        else walk(child, `${at}.${k}`, depth + 1);
      }
    };
    walk(received, "facts", 0);
    assert.deepEqual(functions, [], "a callback on WriteFacts would be a capability, not a fact");
  });
});

// ── the empty case (rule 4) ──────────────────────────────────────────────────

describe("a host with no governance provider", () => {
  test("every consultation is vacuous, and none of them throws", async () => {
    const { consult } = createGovernanceSeam();
    assert.doesNotThrow(() => consult.notifyWrite(facts()));
    assert.equal(await consult.refuseSession("s-1"), null);
    assert.deepEqual(consult.providerIds(), []);
  });

  test("providerIds reports registered ids once each, and drops them on dispose", () => {
    const { seam, consult } = createGovernanceSeam();
    const d1 = seam.registerWriteObserver("governor", () => {});
    const d2 = seam.registerSessionRefusal("governor", () => null);
    seam.registerWriteObserver("other-provider", () => {});
    assert.deepEqual(consult.providerIds().sort(), ["governor", "other-provider"]);
    d1();
    assert.ok(consult.providerIds().includes("governor"), "still registered through its other hook");
    d2();
    assert.deepEqual(consult.providerIds(), ["other-provider"]);
  });

  test("providerIds hands back a COPY — a caller cannot edit the host's view of who is registered", () => {
    const { seam, consult } = createGovernanceSeam();
    seam.registerWriteObserver("governor", () => {});
    const ids = consult.providerIds();
    ids.length = 0;
    assert.deepEqual(consult.providerIds(), ["governor"]);
  });
});

// ── privacy of the hook lists (condition 1) ──────────────────────────────────

describe("the hook LISTS are module-private", () => {
  test("neither returned object exposes a registered closure", () => {
    // Deliberately NOT a transitive walk of `app`: the retriage kept the
    // WeakMap placement (it is free) and dropped the adversarial reachability
    // proof, because walking `app` is a test shaped around an actor §0
    // excludes. This is the cheap half — the objects the host actually hands
    // out hold no hook.
    const { seam, consult } = createGovernanceSeam();
    const marker = () => {};
    seam.registerWriteObserver("governor", marker);
    seam.registerSessionRefusal("governor", marker);
    const found = [];
    const walk = (v, at, depth, seen) => {
      if (depth > 5 || v === null || (typeof v !== "object" && typeof v !== "function")) return;
      if (seen.has(v)) return;
      seen.add(v);
      for (const [k, child] of Object.entries(v)) {
        if (child === marker) found.push(`${at}.${k}`);
        walk(child, `${at}.${k}`, depth + 1, seen);
      }
    };
    walk({ seam, consult }, "returned", 0, new Set());
    assert.deepEqual(found, [], "a reachable observer is a proposal factory callable with forged facts");
  });

  test("SOURCE: the seam holds its hooks in a WeakMap and never on a passed-in object", () => {
    const src = readFileSync(new URL("../src/mcp/seam.ts", import.meta.url), "utf8");
    assert.match(src, /const HOOKS = new WeakMap</, "the wiring.ts pattern, not a property");
    assert.ok(!/this\.(observers|sessionRefusals|hooks)\b/.test(src), "no hook list on an instance");
    assert.ok(!/plugin\.(observers|sessionRefusals|hooks)\b/.test(src), "no hook list on the plugin");
  });

  test("SOURCE: main.ts holds the external-tool registry and the seam in module WeakMaps", () => {
    // The other half of condition 1: `private externalRegistry` was
    // compile-time privacy only, so `app.plugins.plugins.governor.externalRegistry`
    // handed renderer JS every third-party handler — and would have handed it
    // the seam's hooks the moment the seam lived beside it.
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    assert.match(main, /const externalRegistries = new WeakMap</);
    assert.match(main, /const governanceSeams = new WeakMap</);
    assert.ok(!/private externalRegistry/.test(main), "a `private` field is not a boundary");
    // Registration IS reachable, and that is fine and intended (§3) — what must
    // not be reachable is the list of what everyone else registered.
    assert.match(main, /registerWriteObserver: \(id, observe\)/, "the api still offers registration");
  });
});

// ── the host's side: reporting a write, and the expiry floor ─────────────────

describe("reportCompletedWrite — attribution is the host's job", () => {
  const op = { id: "op-1", action: { id: "note.write", version: 1 }, sessionId: "s-1" };
  const ACTOR = { transport: "mcp", connection: "c-1" };
  const wrote = { path: "A.md", baseBytes: enc("old"), proposedBytes: enc("new") };

  function world() {
    const { seam, consult } = createGovernanceSeam();
    const seen = [];
    seam.registerWriteObserver("governor", (f) => seen.push(f));
    return { consult, seen };
  }

  test("facts matching the operation's sources are reported, shaped as WriteFacts", async () => {
    const { consult, seen } = world();
    assert.equal(reportCompletedWrite(consult, wrote, op, ["A.md"], ACTOR), true);
    await settle();
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].operation, { id: "op-1", action: "note.write", actionVersion: 1, sessionId: "s-1" });
    assert.deepEqual(seen[0].actor, ACTOR);
    assert.equal(seen[0].path, "A.md");
  });

  test("MIS-ATTRIBUTED facts are dropped — a proposal about a write that did not happen is worse than none", async () => {
    const { consult, seen } = world();
    assert.equal(reportCompletedWrite(consult, { ...wrote, path: "SOMEWHERE-ELSE.md" }, op, ["A.md"], ACTOR), false);
    await settle();
    assert.deepEqual(seen, [], "nothing crossed the seam");
  });

  test("an empty slot reports nothing — a read after a write cannot inherit its facts", async () => {
    const { consult, seen } = world();
    assert.equal(reportCompletedWrite(consult, null, op, ["A.md"], ACTOR), false);
    await settle();
    assert.deepEqual(seen, []);
  });

  test("no seam at all is a supported configuration, not a crash", () => {
    assert.equal(reportCompletedWrite(undefined, wrote, op, ["A.md"], ACTOR), false);
  });

  test("a null sessionId crosses as null, never as an invented id", async () => {
    const { consult, seen } = world();
    reportCompletedWrite(consult, wrote, { ...op, sessionId: null }, ["A.md"], ACTOR);
    await settle();
    assert.equal(seen[0].operation.sessionId, null);
  });
});

describe("expiryRefusal — the host's own floor, with no provider installed", () => {
  const T0 = 1_700_000_000_000;
  const open = (over = {}) => ({
    ...openSession(
      { vaultId: "v", replicaId: "r", actor: { connection: "c", clientClaim: null }, journalHead: null, scopeDigest: "d" },
      T0
    ),
    ...over,
  });

  test("no session at all refuses nothing", () => {
    assert.equal(expiryRefusal(null, T0), null);
  });

  test("a live session refuses nothing", () => {
    assert.equal(expiryRefusal(open(), T0 + 1000), null);
  });

  test("an EXPIRED session refuses, coded and named — no store, no provider, no timer involved", () => {
    const s = open();
    const r = expiryRefusal(s, T0 + SESSION_TTL_MS + 1);
    assert.equal(r.code, "session_not_live");
    assert.equal(r.status, "expired");
    assert.match(r.detail, /is expired/);
    assert.ok(r.detail.includes(s.id), "the refusal names the session, so an agent can tell which one died");
  });

  test("a REVOKED session refuses with its own status — the host reports what its record says", () => {
    // In service, revocation reaches the host through the seam (it lands in the
    // provider's store, which the host does not read). This is the case where
    // the host's OWN copy already carries the transition — belt beside braces.
    const r = expiryRefusal(revokeSession(open(), "a human said so"), T0 + 1000);
    assert.equal(r.status, "revoked");
    assert.match(r.detail, /is revoked/);
  });
});

// ── condition 6: a registered provider cannot be switched off by an agent ────

describe("the plugin tools refuse a registered governance provider", async () => {
  const { installObsidianStub } = await import("./obsidian-stub.mjs");
  installObsidianStub();
  const { registerNavTools } = await import("../src/mcp/tools-nav.ts");
  const { registerCliDedicatedTools } = await import("../src/mcp/tools-cli-dedicated.ts");
  const { fakeServer } = await import("./fake-server.mjs");

  function toggleWorld(seamConsult) {
    const tools = new Map();
    const disabled = [];
    const app = {
      plugins: {
        plugins: {},
        enabledPlugins: new Set(),
        enablePlugin: async () => {},
        disablePlugin: async (id) => disabled.push(id),
      },
    };
    registerNavTools(
      { registerTool: (name, def, handler) => tools.set(name, { def, handler }) },
      app,
      { getSettings: () => ({ readOnly: false, allowlist: [] }), seam: seamConsult }
    );
    return { call: (args) => tools.get("obsidian_plugin_toggle").handler(args, {}), disabled };
  }

  function uninstallWorld(seamConsult) {
    const server = fakeServer();
    const ran = [];
    registerCliDedicatedTools(
      server,
      {
        pluginVersion: "0",
        socketPath: "/tmp/x.sock",
        vaultName: "testvault",
        enabledPlugins: () => [],
        getSettings: () => ({ readOnly: false, allowlist: [], allowDangerousCli: true }),
        seam: seamConsult,
      },
      {
        binary: "/bin/obsidian",
        exec: async (bin, args) => { ran.push(args); return { exitCode: 0, stdout: "", stderr: "", timedOut: false }; },
      }
    );
    return { call: (args) => server.tools.get("obsidian_plugin_uninstall").handler(args, {}), ran };
  }

  const text = (res) => res.content?.[0]?.text ?? "";

  test("obsidian_plugin_toggle refuses to DISABLE a registered provider, and really disables anything else", async () => {
    const { seam, consult } = createGovernanceSeam();
    seam.registerSessionRefusal("acme-governance", () => null);
    const world = toggleWorld(consult);

    const refused = await world.call({ plugin_id: "acme-governance", enabled: false });
    assert.ok(refused.isError, "refused");
    assert.match(text(refused), /registered governance provider/);
    assert.deepEqual(world.disabled, [], "nothing was disabled");

    // The control, and the vacuity check in one: an unregistered plugin still
    // gets disabled, so the refusal is the provider rule and not a blanket stop.
    const allowed = await world.call({ plugin_id: "dataview", enabled: false });
    assert.ok(!allowed.isError);
    assert.deepEqual(world.disabled, ["dataview"]);
  });

  test("ENABLING a registered provider is still allowed — the rule is about switching it OFF", async () => {
    const { seam, consult } = createGovernanceSeam();
    seam.registerSessionRefusal("acme-governance", () => null);
    const res = await toggleWorld(consult).call({ plugin_id: "acme-governance", enabled: true });
    assert.ok(!res.isError);
  });

  test("once the provider's last hook is disposed, the tool stops refusing it", async () => {
    // "Registered" means IN SERVICE, not "was once mentioned". This is also
    // what keeps the rule from becoming a permanent block on an id nobody uses
    // — the persisted latch that WOULD do that is deferred to
    // `reference/hostile-threat-model` on purpose.
    const { seam, consult } = createGovernanceSeam();
    const dispose = seam.registerWriteObserver("acme-governance", () => {});
    const world = toggleWorld(consult);
    assert.ok((await world.call({ plugin_id: "acme-governance", enabled: false })).isError);
    dispose();
    assert.ok(!(await world.call({ plugin_id: "acme-governance", enabled: false })).isError);
    assert.deepEqual(world.disabled, ["acme-governance"]);
  });

  test("obsidian_plugin_uninstall refuses a registered provider outright — no enabled branch to hide behind", async () => {
    const { seam, consult } = createGovernanceSeam();
    seam.registerWriteObserver("acme-governance", () => {});
    const world = uninstallWorld(consult);

    const refused = await world.call({ plugin_id: "acme-governance" });
    assert.ok(refused.isError);
    assert.match(text(refused), /registered governance provider/);
    assert.deepEqual(world.ran, [], "the CLI never ran");

    const allowed = await world.call({ plugin_id: "dataview" });
    assert.ok(!allowed.isError, "an ordinary plugin still uninstalls — the guard is specific");
    assert.equal(world.ran.length, 1);
  });

  test("a host with no seam at all keeps the old behaviour exactly", async () => {
    // `ctx.seam` is optional, and a build without one (tests, bare embeds, a
    // host with no provider installed) must not start refusing plugin
    // management on account of machinery it does not have.
    const world = toggleWorld(undefined);
    assert.ok(!(await world.call({ plugin_id: "dataview", enabled: false })).isError);
    assert.deepEqual(world.disabled, ["dataview"]);
    const un = uninstallWorld(undefined);
    assert.ok(!(await un.call({ plugin_id: "dataview" })).isError);
  });
});
