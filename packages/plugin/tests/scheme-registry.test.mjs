/**
 * scheme-registry.test.mjs — Task 3 of the scope-provider module: the
 * SchemeRegistry (multiple named scheme instances, each a provider + merged
 * config) and address-string resolution ("jd:06.11" -> a vault path).
 *
 * The NOTES fixture mirrors scheme-jd-scopes.test.mjs's Task-2 listing.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  makeRegistry,
  DEFAULT_SCHEMES,
  SchemeRegistry,
  AddressUnresolvedError,
  AddressAmbiguousError,
  requireOneAddress,
} from "../src/kernel/scheme/registry.js";
import { DEFAULT_JD_CONFIG } from "../src/kernel/scheme/jd.js";

const NOTES = [
  "00-09 System/00.00 Index.md",
  "00-09 System/06 Agent tooling/06.00 JDex.md",
  "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
  "00-09 System/06 Agent tooling/06.12 Bridge.md",
  "00-09 System/06 Agent tooling/scratch no address.md",
  "90-99 Projects/92021 Big thing/92021.10 Sub.md",
  "Unfiled/loose.md",
];

// ── makeRegistry / instances / get ──────────────────────────────────────────

describe("makeRegistry — building instances from config", () => {
  test("the default config registers one 'jd' instance backed by the JD provider", () => {
    const reg = makeRegistry(DEFAULT_SCHEMES);
    const instances = reg.instances();
    assert.equal(instances.length, 1);
    assert.equal(instances[0].id, "jd");
    assert.equal(instances[0].providerName, "johnny-decimal");
    assert.equal(typeof instances[0].provider.parse, "function");
  });

  test("get(id) returns the matching instance", () => {
    const reg = makeRegistry(DEFAULT_SCHEMES);
    const inst = reg.get("jd");
    assert.ok(inst);
    assert.equal(inst.id, "jd");
  });

  test("get(id) returns null for an unregistered id", () => {
    const reg = makeRegistry(DEFAULT_SCHEMES);
    assert.equal(reg.get("nope"), null);
  });

  test("an unknown provider name in a config is skipped (console.error), not thrown", () => {
    const originalError = console.error;
    let called = false;
    console.error = () => {
      called = true;
    };
    let reg;
    try {
      reg = makeRegistry([{ id: "bogus", provider: "not-a-real-provider" }]);
    } finally {
      console.error = originalError;
    }
    assert.equal(reg.instances().length, 0);
    assert.equal(reg.get("bogus"), null);
    assert.ok(called, "expected console.error to be called for the bad config entry");
  });

  test("prototype-key provider names (__proto__, constructor, toString, hasOwnProperty, valueOf) are skipped, not thrown", () => {
    const PROTOTYPE_KEYS = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"];
    for (const provider of PROTOTYPE_KEYS) {
      const originalError = console.error;
      let called = false;
      console.error = () => {
        called = true;
      };
      let reg;
      try {
        reg = makeRegistry([{ id: "bogus", provider }]);
      } finally {
        console.error = originalError;
      }
      assert.equal(reg.instances().length, 0, `provider "${provider}" should register 0 instances`);
      assert.equal(reg.get("bogus"), null, `provider "${provider}" should not be gettable`);
      assert.ok(called, `expected console.error to be called for provider "${provider}"`);
    }
  });

  test("a bad config entry does not prevent good entries alongside it from registering", () => {
    const originalError = console.error;
    console.error = () => {};
    let reg;
    try {
      reg = makeRegistry([
        { id: "bogus", provider: "not-a-real-provider" },
        { id: "jd", provider: "johnny-decimal" },
      ]);
    } finally {
      console.error = originalError;
    }
    assert.equal(reg.instances().length, 1);
    assert.equal(reg.instances()[0].id, "jd");
  });

  test("per-instance config deep-merges over provider defaults at the key level", () => {
    // Overriding only expandedCategories must leave expandedAreas at its
    // provider default ["90-99"] — not clobber the whole config object.
    const reg = makeRegistry([{ id: "jd", provider: "johnny-decimal", config: { expandedCategories: ["27", "31"] } }]);
    const inst = reg.get("jd");
    // 92021 is only an expanded-item if area 90-99 (the untouched default) is
    // still expanded.
    assert.equal(inst.provider.parse("92021")?.kind, "expanded-item");
    // 31001 is only an expanded-item because expandedCategories now includes "31".
    assert.equal(inst.provider.parse("31001")?.kind, "expanded-item");
    // Sanity: the merged config actually differs from the untouched default.
    assert.notDeepEqual(inst.provider.parse("31001"), null);
  });

  // ── Task 5: registry-from-settings ──────────────────────────────────────────

  test("makeRegistry(DEFAULT_SCHEMES) — the settings default — merges DEFAULT_JD_CONFIG under partial overrides", () => {
    // DEFAULT_SCHEMES is exactly what VaultMcpSettings.schemes defaults to
    // (main.ts DEFAULT_SETTINGS.schemes = DEFAULT_SCHEMES). A settings-loaded
    // instance with a partial config override must merge the SAME way a
    // hand-built one does — expandedAreas untouched at its provider default.
    const settingsLikeConfigs = [{ id: "jd", provider: "johnny-decimal", config: { expandedCategories: ["27", "31"] } }];
    const reg = makeRegistry(settingsLikeConfigs);
    const inst = reg.get("jd");
    assert.equal(inst.provider.parse("92021")?.kind, "expanded-item"); // expandedAreas default preserved
    assert.equal(inst.provider.parse("31001")?.kind, "expanded-item"); // expandedCategories override applied

    // The untouched DEFAULT_SCHEMES entry itself builds the same as an empty override.
    const defaultReg = makeRegistry(DEFAULT_SCHEMES);
    const defaultInst = defaultReg.get("jd");
    assert.deepEqual(defaultInst.provider.parse("90001"), inst.provider.parse("90001"));
  });

  // ── Amendment 2: flexible user config, validated by the provider ───────────

  test("an invalid config (expandedAreas as a string, not an array) is skipped with console.error, not thrown", () => {
    const originalError = console.error;
    const messages = [];
    console.error = (msg) => messages.push(msg);
    let reg;
    try {
      reg = makeRegistry([{ id: "jd", provider: "johnny-decimal", config: { expandedAreas: "90-99" } }]);
    } finally {
      console.error = originalError;
    }
    assert.equal(reg.instances().length, 0);
    assert.equal(reg.get("jd"), null);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /expandedAreas must be an array of strings/);
  });

  test("an invalid contentDecimalFloor (out of range) is skipped with console.error listing the problem", () => {
    const originalError = console.error;
    const messages = [];
    console.error = (msg) => messages.push(msg);
    let reg;
    try {
      reg = makeRegistry([{ id: "jd", provider: "johnny-decimal", config: { contentDecimalFloor: 100 } }]);
    } finally {
      console.error = originalError;
    }
    assert.equal(reg.instances().length, 0);
    assert.match(messages[0], /contentDecimalFloor must be an integer between 0 and 99/);
  });

  test("a valid contentDecimalFloor override changes nextFree's plain-category allocation (floor 5 -> 06.05)", () => {
    const reg = makeRegistry([{ id: "jd", provider: "johnny-decimal", config: { contentDecimalFloor: 5 } }]);
    const inst = reg.get("jd");
    const notes = ["00-09 System/06 Agent tooling/06.00 JDex.md"];
    const next = inst.provider.nextFree({ kind: "category", token: "06" }, notes);
    assert.equal(inst.provider.format(next), "06.05");
  });

  test("contentDecimalFloor absent from config preserves default behavior (-> 06.10)", () => {
    const reg = makeRegistry(DEFAULT_SCHEMES);
    const inst = reg.get("jd");
    const notes = ["00-09 System/06 Agent tooling/06.00 JDex.md"];
    const next = inst.provider.nextFree({ kind: "category", token: "06" }, notes);
    assert.equal(inst.provider.format(next), "06.10");
  });
});

// ── parseRef ─────────────────────────────────────────────────────────────────

describe("parseRef — 'scheme:address' -> {instance, addr} | null", () => {
  const reg = makeRegistry(DEFAULT_SCHEMES);

  test("a well-formed ref against a registered scheme parses", () => {
    const parsed = reg.parseRef("jd:06.11");
    assert.ok(parsed);
    assert.equal(parsed.instance.id, "jd");
    assert.equal(parsed.addr.kind, "id");
    assert.equal(reg.get("jd").provider.format(parsed.addr), "06.11");
  });

  test("'uid:...' is reserved and always returns null, even though it matches the ref shape", () => {
    assert.equal(reg.parseRef("uid:abc"), null);
  });

  test("an ordinary path containing a colon (not scheme-shaped) returns null", () => {
    // Starts with an uppercase letter / contains a slash before the colon —
    // does not match the scheme-id grammar at all.
    assert.equal(reg.parseRef("Notes/a:b.md"), null);
  });

  test("a colon-prefixed id that isn't registered returns null", () => {
    assert.equal(reg.parseRef("nope:06.11"), null);
  });

  test("a registered scheme id with an unparseable address returns null", () => {
    assert.equal(reg.parseRef("jd:not-a-jd-id"), null);
  });

  test("a plain path with no colon at all returns null", () => {
    assert.equal(reg.parseRef("Unfiled/loose.md"), null);
  });
});

// ── resolve ──────────────────────────────────────────────────────────────────

describe("resolve — canonical-form address equality against a notes listing", () => {
  const reg = makeRegistry(DEFAULT_SCHEMES);
  const jd = reg.get("jd");

  test("resolves to the single matching path", () => {
    const addr = jd.provider.parse("06.11");
    assert.deepEqual(reg.resolve(jd, addr, NOTES), ["00-09 System/06 Agent tooling/06.11 Vault MCP.md"]);
  });

  test("an address with no matching note resolves to an empty list", () => {
    const addr = jd.provider.parse("99.99");
    assert.deepEqual(reg.resolve(jd, addr, NOTES), []);
  });

  test("two notes sharing the same address both come back, in listing order", () => {
    const notes = ["00-09 System/06 Agent tooling/06.11 First.md", "00-09 System/06 Agent tooling/06.11 Second.md"];
    const addr = jd.provider.parse("06.11");
    assert.deepEqual(reg.resolve(jd, addr, notes), notes);
  });
});

// ── requireOneAddress ────────────────────────────────────────────────────────

describe("requireOneAddress — throws on 0 or 2+ candidates, else returns the one path", () => {
  const reg = makeRegistry(DEFAULT_SCHEMES);

  test("resolves 'jd:06.11' against the NOTES listing to the one path", () => {
    assert.equal(requireOneAddress(reg, "jd:06.11", NOTES), "00-09 System/06 Agent tooling/06.11 Vault MCP.md");
  });

  test("'jd:99.99' throws AddressUnresolvedError with code 'address_unresolved'", () => {
    assert.throws(
      () => requireOneAddress(reg, "jd:99.99", NOTES),
      (err) => {
        assert.ok(err instanceof AddressUnresolvedError);
        assert.equal(err.code, "address_unresolved");
        return true;
      },
    );
  });

  test("two notes sharing '06.11 *' throw AddressAmbiguousError naming both candidates", () => {
    const notes = ["00-09 System/06 Agent tooling/06.11 First.md", "00-09 System/06 Agent tooling/06.11 Second.md"];
    assert.throws(
      () => requireOneAddress(reg, "jd:06.11", notes),
      (err) => {
        assert.ok(err instanceof AddressAmbiguousError);
        assert.equal(err.code, "address_ambiguous");
        assert.deepEqual(err.candidates, notes);
        for (const path of notes) {
          assert.ok(err.message.includes(path), `message should name candidate ${path}`);
        }
        return true;
      },
    );
  });

  test("a ref that isn't scheme-shaped (not registered / unparseable) also throws AddressUnresolvedError", () => {
    assert.throws(() => requireOneAddress(reg, "nope:06.11", NOTES), AddressUnresolvedError);
  });
});
