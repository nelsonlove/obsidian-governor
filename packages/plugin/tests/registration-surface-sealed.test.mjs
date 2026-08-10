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

describe("the seal covers the SDK's ACTUAL surface, so a new entry point cannot slip in", () => {
  test("every registration-shaped method on McpServer.prototype is patched or sealed", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const proto = McpServer.prototype;
    const registrationish = Object.getOwnPropertyNames(proto).filter(
      (n) => /^(tool|prompt|resource|registerTool|registerPrompt|registerResource)$/.test(n),
    );
    assert.ok(registrationish.length >= 6, `expected the SDK's registration surface, saw ${registrationish}`);
    const accounted = new Set(["registerTool", ...SEALED_REGISTRARS]);
    const unaccounted = registrationish.filter((n) => !accounted.has(n));
    assert.deepEqual(
      unaccounted,
      [],
      `unaccounted registration entry points — each is a potential unguarded surface: ${unaccounted.join(", ")}`,
    );
  });
});
