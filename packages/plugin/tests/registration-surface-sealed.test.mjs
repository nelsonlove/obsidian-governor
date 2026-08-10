/**
 * registration-surface-sealed.test.mjs — #83's gate finding.
 *
 * `module.ts` promises modules register at ONE interception point, "guarded,
 * queued, journaled, kernel-args-declared, with no module-specific bypass
 * possible." That was stronger than what was enforced: `buildMcpServer`
 * monkey-patched exactly `registerTool`, while the SDK's `McpServer` also
 * exposes `tool`, `prompt`, `registerPrompt`, `resource` and
 * `registerResource`. Anything holding a server-shaped object — and
 * `moduleFromRegistrar` hands adapted modules the real server — could register
 * a surface that never passed `makeGuarded`: no guard, no allowlist, no
 * read-only mode, no kernel args, no queue, no journal.
 *
 * No live bypass existed (our own code only ever calls `registerTool`), but the
 * sentence is what a future governance author would rely on, and #83 mounts the
 * ACCEPT-VETO module into this topology. A containment claim that overstates
 * what is enforced is the thing to fix before governance arrives, not after.
 *
 * The second test is the one that matters long-term: it enumerates the SDK
 * prototype's registration-shaped methods and asserts EVERY one is either
 * patched or sealed. A future SDK release adding a sixth entry point fails here
 * instead of silently opening the hole again — closing the CLASS, not the five
 * instances.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sealUnguardedRegistration, SEALED_REGISTRARS } from "../src/mcp/seal-registration.ts";

/** A stand-in with the SDK's registration surface. */
function fakeServer() {
  const calls = [];
  return {
    calls,
    registerTool: (n) => calls.push(["registerTool", n]),
    tool: (n) => calls.push(["tool", n]),
    prompt: (n) => calls.push(["prompt", n]),
    registerPrompt: (n) => calls.push(["registerPrompt", n]),
    resource: (n) => calls.push(["resource", n]),
    registerResource: (n) => calls.push(["registerResource", n]),
  };
}

describe("#83 — every registration entry point except registerTool is sealed", () => {
  for (const m of ["tool", "prompt", "registerPrompt", "resource", "registerResource"]) {
    test(`${m}() throws instead of registering an unguarded surface`, () => {
      const s = fakeServer();
      sealUnguardedRegistration(s);
      assert.throws(() => s[m]("x"), /guard|sealed|registerTool/i, `${m} must not silently register`);
      assert.deepEqual(s.calls, [], "nothing may be registered by a sealed method");
    });
  }

  test("registerTool is NOT sealed — it is the guarded interception point", () => {
    const s = fakeServer();
    sealUnguardedRegistration(s);
    assert.doesNotThrow(() => s.registerTool("ok"));
    assert.deepEqual(s.calls, [["registerTool", "ok"]]);
  });

  test("sealing is idempotent — a second call does not double-wrap or unseal", () => {
    const s = fakeServer();
    sealUnguardedRegistration(s);
    sealUnguardedRegistration(s);
    assert.throws(() => s.tool("x"), /guard|sealed|registerTool/i);
    assert.doesNotThrow(() => s.registerTool("ok"));
  });

  test("a method the SDK does not expose is skipped, not invented", () => {
    const partial = { registerTool: () => {}, tool: () => {} };
    sealUnguardedRegistration(partial);
    assert.equal(typeof partial.prompt, "undefined", "must not add methods the server never had");
  });
});

/**
 * The class-level guarantee, rewritten after review (#170).
 *
 * The FIRST version filtered `McpServer.prototype` with a hardcoded regex of
 * the six names already known. That closed the five INSTANCES while its comment
 * claimed it closed the CLASS: a genuinely new entry point could never enter
 * the candidate set, so it could never be reported unaccounted. Demonstrated by
 * the reviewer against the real SDK — adding `registerWidget` to the prototype
 * registered unguarded with the suite fully green.
 *
 * My own mutation missed it for an instructive reason: dropping a name from
 * SEALED_REGISTRARS proves detection of LIST SHRINKAGE — an unaccounted method
 * among names the regex already knew. It cannot prove detection of a name the
 * regex was never told about. Different properties, and only the second is
 * "closing the class". Precisely the distinction that made 9 of 10 tests
 * vacuous on #142, reproduced here in the PR that existed to fix this shape.
 *
 * So: EVERY method on the prototype must be classified — guarded, sealed, or
 * explicitly recorded as not-registration. Anything new is unaccounted BY
 * DEFAULT and fails until a human classifies it. That is the same fail-closed
 * discipline the accept guard uses, turned on the test itself.
 */

/** Prototype members reviewed and confirmed NOT to register a client-reachable
 * surface. Adding to this list is a deliberate act with a reviewer, which is
 * the point — it is the human classification step, not a convenience. */
const KNOWN_NOT_REGISTRATION = [
  "constructor", "experimental", "connect", "close", "isConnected",
  "setToolRequestHandlers", "createToolError", "validateToolInput",
  "validateToolOutput", "executeToolHandler", "handleAutomaticTaskPolling",
  "setCompletionRequestHandler", "handlePromptCompletion",
  "handleResourceCompletion", "setResourceRequestHandlers",
  "setPromptRequestHandlers",
  // Internal factories: reachable only from the public registrars above, which
  // are themselves guarded or sealed.
  "_createRegisteredResource", "_createRegisteredResourceTemplate",
  "_createRegisteredPrompt", "_createRegisteredTool",
  // Notifications and logging — emit, never register.
  "sendLoggingMessage", "sendResourceListChanged", "sendToolListChanged",
  "sendPromptListChanged",
];

describe("the seal covers the SDK's ACTUAL surface, so a NEW entry point cannot slip in", () => {
  test("every prototype member is classified: guarded, sealed, or known-not-registration", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const all = Object.getOwnPropertyNames(McpServer.prototype);
    const accounted = new Set(["registerTool", ...SEALED_REGISTRARS, ...KNOWN_NOT_REGISTRATION]);
    const unaccounted = all.filter((n) => !accounted.has(n));
    assert.deepEqual(
      unaccounted,
      [],
      `unclassified McpServer member(s): ${unaccounted.join(", ")}. Each is a potential unguarded ` +
        `registration surface. Seal it (SEALED_REGISTRARS), route it through the guard, or — only ` +
        `after confirming it registers nothing client-reachable — add it to KNOWN_NOT_REGISTRATION.`,
    );
  });

  test("an UNKNOWN new member is unaccounted by default — the property the first version lacked", () => {
    // Simulates a future SDK release adding an entry point nobody has heard of.
    const proto = { registerTool() {}, tool() {}, registerWidget() {} };
    const all = Object.getOwnPropertyNames(proto);
    const accounted = new Set(["registerTool", ...SEALED_REGISTRARS, ...KNOWN_NOT_REGISTRATION]);
    assert.deepEqual(
      all.filter((n) => !accounted.has(n)),
      ["registerWidget"],
      "a name nobody enumerated must land in unaccounted, not be filtered away",
    );
  });

  test("sealing does not silently cover an unknown method either — it is refused, not assumed safe", () => {
    const s = { registerTool: () => {}, registerWidget: () => "registered!" };
    sealUnguardedRegistration(s);
    // The seal only touches names it knows; the TEST above is what catches the
    // rest. Pinning the division of labour so a later reader does not assume
    // the seal alone is sufficient.
    assert.equal(s.registerWidget(), "registered!");
    assert.ok(
      !new Set(["registerTool", ...SEALED_REGISTRARS, ...KNOWN_NOT_REGISTRATION]).has("registerWidget"),
      "and the classification test is what fails on it",
    );
  });
});
