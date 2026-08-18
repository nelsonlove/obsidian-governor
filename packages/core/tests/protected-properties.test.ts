/**
 * protected-properties.test.ts — the declared protected-property perimeter (#224).
 *
 * The accept guard's ONE rule, generalized: a declared list (from plugin
 * settings) of frontmatter keys agents may not introduce / change / remove
 * through any guarded transport, enforced INSIDE the same two predicates every
 * transport already calls. These tests pin:
 *
 *   • normalization — untrusted config coerces safely; FLOOR IMMUTABILITY (a
 *     config naming the accepted family or acceptance-status is ignored loudly
 *     and the hardcoded floor still enforces);
 *   • the registry — set/get, setter normalizes, default list;
 *   • grade semantics at the predicates — introduce/change/remove refused,
 *     byte-identical carry-forward allowed, case/underscore variants caught;
 *   • the payload predicate — declared presence refuses (the CLI/fileclass
 *     paths' semantics, matching the accepted family there);
 *   • acceptTransitionNeedsBefore — the fast-path helper;
 *   • the settings-line codec round-trip;
 *   • byte-compat — with an EMPTY declared list the predicates behave exactly
 *     as they always did (the accepted family checks run unconditionally).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  AcceptForbiddenError,
  DEFAULT_PROTECTED_PROPERTIES,
  acceptForbiddenReason,
  acceptTransitionNeedsBefore,
  acceptTransitionReason,
  canonicalPropertyKey,
  declaredGradeOf,
  declaredProtectedProperties,
  formatProtectedPropertyLines,
  normalizeProtectedProperties,
  parseProtectedPropertyLines,
  setDeclaredProtectedProperties,
  unverifiableProtectedPropertyIn,
} from "../src/accept-guard.js";

const silent = () => {};

// Every test starts from the shipped default and the file restores it at the end,
// so ordering effects cannot leak between tests (node --test runs each FILE in its
// own process, so no other suite sees these mutations at all).
beforeEach(() => setDeclaredProtectedProperties(DEFAULT_PROTECTED_PROPERTIES, silent));
after(() => setDeclaredProtectedProperties(DEFAULT_PROTECTED_PROPERTIES, silent));

describe("normalizeProtectedProperties — untrusted config coercion", () => {
  test("non-array input falls back to the shipped default", () => {
    assert.deepEqual(normalizeProtectedProperties(undefined, silent), [...DEFAULT_PROTECTED_PROPERTIES]);
    assert.deepEqual(normalizeProtectedProperties("junk", silent), [...DEFAULT_PROTECTED_PROPERTIES]);
    assert.deepEqual(normalizeProtectedProperties({ key: "x" }, silent), [...DEFAULT_PROTECTED_PROPERTIES]);
  });

  test("an EMPTY array is respected (a human may declare nothing)", () => {
    assert.deepEqual(normalizeProtectedProperties([], silent), []);
  });

  test("keys canonicalize (trim, lowercase, _ folded to -)", () => {
    assert.deepEqual(normalizeProtectedProperties([{ key: "  Auto_Accept ", grade: "authority-conferring" }], silent), [
      { key: "auto-accept", grade: "authority-conferring" },
    ]);
  });

  test("unknown grades are DROPPED loudly, never guessed", () => {
    const warned: string[] = [];
    const out = normalizeProtectedProperties(
      [{ key: "steward", grade: "authority" }, { key: "tier", grade: "agent-forbidden" }],
      (m) => warned.push(m)
    );
    assert.deepEqual(out, [{ key: "tier", grade: "agent-forbidden" }]);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /unknown grade/);
  });

  test("entries with no key are dropped loudly", () => {
    const warned: string[] = [];
    assert.deepEqual(normalizeProtectedProperties([{ grade: "agent-forbidden" }, null, 42], (m) => warned.push(m)), []);
    assert.equal(warned.length, 3);
  });

  test("duplicates (canonical) — first declaration wins, loudly", () => {
    const warned: string[] = [];
    const out = normalizeProtectedProperties(
      [
        { key: "auto-accept", grade: "authority-conferring" },
        { key: "AUTO_ACCEPT", grade: "agent-forbidden" },
      ],
      (m) => warned.push(m)
    );
    assert.deepEqual(out, [{ key: "auto-accept", grade: "authority-conferring" }]);
    assert.equal(warned.length, 1);
  });

  test("FLOOR IMMUTABILITY: accepted-family and acceptance-status entries are ignored loudly", () => {
    const warned: string[] = [];
    const out = normalizeProtectedProperties(
      [
        { key: "accepted", grade: "agent-forbidden" },
        { key: "accepted-by", grade: "authority-conferring" },
        { key: "Accepted_On", grade: "agent-forbidden" },
        { key: "acceptance-status", grade: "agent-forbidden" },
        { key: "acceptance_status", grade: "authority-conferring" },
        { key: "steward", grade: "agent-forbidden" },
      ],
      (m) => warned.push(m)
    );
    assert.deepEqual(out, [{ key: "steward", grade: "agent-forbidden" }]);
    assert.equal(warned.length, 5);
    for (const w of warned) assert.match(w, /hardcoded floor/);
  });
});

describe("the registry", () => {
  test("default: the shipped list (auto-accept, authority-conferring)", () => {
    assert.deepEqual([...declaredProtectedProperties()], [{ key: "auto-accept", grade: "authority-conferring" }]);
    assert.equal(declaredGradeOf("auto-accept"), "authority-conferring");
    assert.equal(declaredGradeOf("AUTO_ACCEPT"), "authority-conferring");
    assert.equal(declaredGradeOf("nothing"), null);
  });

  test("the setter itself normalizes — a direct mis-set cannot smuggle a floor key in", () => {
    setDeclaredProtectedProperties([{ key: "accepted-by", grade: "agent-forbidden" }, { key: "tier", grade: "agent-forbidden" }], silent);
    assert.deepEqual([...declaredProtectedProperties()], [{ key: "tier", grade: "agent-forbidden" }]);
  });
});

describe("acceptTransitionReason — declared-property grade semantics", () => {
  beforeEach(() =>
    setDeclaredProtectedProperties(
      [...DEFAULT_PROTECTED_PROPERTIES, { key: "review-tier", grade: "agent-forbidden" }],
      silent
    )
  );

  test("INTRODUCE refused", () => {
    const r = acceptTransitionReason({}, { "auto-accept": "appends" });
    assert.match(r ?? "", /introduce the protected property 'auto-accept'/);
  });

  test("CHANGE refused", () => {
    const r = acceptTransitionReason({ "auto-accept": "appends" }, { "auto-accept": "all" });
    assert.match(r ?? "", /change the protected property 'auto-accept'/);
  });

  test("REMOVE refused — omission is a mutation for declared keys", () => {
    const r = acceptTransitionReason({ "auto-accept": "appends", title: "x" }, { title: "x" });
    assert.match(r ?? "", /remove the protected property 'auto-accept'/);
  });

  test("REMOVE refused even when the result has NO frontmatter at all", () => {
    const r = acceptTransitionReason({ "review-tier": 2 }, null);
    assert.match(r ?? "", /remove the protected property 'review-tier'/);
  });

  test("byte-identical carry-forward ALLOWED (deep values too)", () => {
    assert.equal(acceptTransitionReason({ "auto-accept": "appends" }, { "auto-accept": "appends", title: "x" }), null);
    assert.equal(
      acceptTransitionReason({ "review-tier": { a: [1, 2] } }, { "review-tier": { a: [1, 2] } }),
      null
    );
  });

  test("case/underscore variants cannot dodge the perimeter", () => {
    assert.match(acceptTransitionReason({}, { AUTO_ACCEPT: "all" }) ?? "", /introduce the protected property/);
    assert.match(acceptTransitionReason({}, { " Auto-Accept ": "all" }) ?? "", /introduce the protected property/);
    // carry-forward across the separator forms is still a carry-forward
    assert.equal(acceptTransitionReason({ auto_accept: "appends" }, { "auto-accept": "appends" }), null);
  });

  test("unrelated keys are untouched", () => {
    assert.equal(acceptTransitionReason({ title: "a" }, { title: "b", body: 1 }), null);
  });

  test("second declared key enforced identically (parametrized transport key)", () => {
    assert.match(acceptTransitionReason(null, { "review-tier": 1 }) ?? "", /introduce the protected property 'review-tier'/);
  });

  test("the accepted-family floor still refuses FIRST and unconditionally", () => {
    setDeclaredProtectedProperties([], silent);
    const r = acceptTransitionReason({}, { "acceptance-status": "accepted" });
    assert.match(r ?? "", /accepted value/);
    assert.match(acceptTransitionReason({}, { "accepted-by": "me" }) ?? "", /acceptance field/);
  });
});

describe("acceptForbiddenReason — declared presence on the payload paths", () => {
  test("declared key present refuses (any value, any grade)", () => {
    const r = acceptForbiddenReason({ "auto-accept": "appends" });
    assert.match(r ?? "", /carries the protected property 'auto-accept'/);
  });

  test("variant forms refuse too", () => {
    assert.match(acceptForbiddenReason({ AUTO_ACCEPT: "" }) ?? "", /protected property/);
  });

  test("empty declared list → byte-identical historical behavior", () => {
    setDeclaredProtectedProperties([], silent);
    assert.equal(acceptForbiddenReason({ "auto-accept": "all" }), null);
    assert.match(acceptForbiddenReason({ accepted: true }) ?? "", /acceptance field/);
  });
});

describe("acceptTransitionNeedsBefore — the fast-path helper", () => {
  test("with declared properties the before read is always required (absence may be removal)", () => {
    assert.equal(acceptTransitionNeedsBefore(null), true);
    assert.equal(acceptTransitionNeedsBefore({ title: "x" }), true);
  });

  test("with NONE declared, the historical shortcut holds", () => {
    setDeclaredProtectedProperties([], silent);
    assert.equal(acceptTransitionNeedsBefore(null), false);
    assert.equal(acceptTransitionNeedsBefore({ title: "x" }), false);
    assert.equal(acceptTransitionNeedsBefore({ "accepted-by": "me" }), true);
  });
});

describe("unverifiableProtectedPropertyIn — the unparseable-before removal backstop", () => {
  test("an unclassifiable block mentioning a declared key (either separator form) is flagged", () => {
    assert.equal(unverifiableProtectedPropertyIn("---\n\t: broken\nauto-accept: all\n---\nbody\n"), "auto-accept");
    assert.equal(unverifiableProtectedPropertyIn("---\n\t: broken\nAUTO_ACCEPT: all\n---\nbody\n"), "auto-accept");
  });

  test("an unclassifiable block NOT mentioning any declared key is null (historical fail-toward-null holds)", () => {
    assert.equal(unverifiableProtectedPropertyIn("---\n\t: broken\ntitle: x\n---\nbody\n"), null);
  });

  test("a BODY mention does not flag — the scan is scoped to the frontmatter block", () => {
    assert.equal(unverifiableProtectedPropertyIn("---\n\t: broken\n---\nprose about auto-accept\n"), null);
  });

  test("no fence ⇒ nothing to remove ⇒ null; empty declared list ⇒ null", () => {
    assert.equal(unverifiableProtectedPropertyIn("prose mentioning auto-accept\n"), null);
    setDeclaredProtectedProperties([], silent);
    assert.equal(unverifiableProtectedPropertyIn("---\n\t: broken\nauto-accept: all\n---\n"), null);
  });
});

describe("AcceptForbiddenError — message trailer per refusal family, one code", () => {
  test("declared-property refusals keep the accept_forbidden code but get property guidance", () => {
    const e = new AcceptForbiddenError("write would introduce the protected property 'auto-accept'");
    assert.equal(e.code, "accept_forbidden");
    assert.match(e.message, /Declared protected frontmatter properties are human-only/);
    assert.doesNotMatch(e.message, /Remove the accepted\/accepted-by\/accepted-on field/);
  });

  test("accepted-family refusals keep the exact historical message", () => {
    const e = new AcceptForbiddenError("frontmatter carries the acceptance field 'accepted-by'");
    assert.equal(
      e.message,
      "frontmatter carries the acceptance field 'accepted-by'. The transport never persists acceptance — " +
        "the accept verb is in no API. Remove the accepted/accepted-by/accepted-on field and retry; " +
        "acceptance is a human gesture only."
    );
  });
});

describe("settings-line codec", () => {
  test("round-trips", () => {
    const list = [
      { key: "auto-accept", grade: "authority-conferring" },
      { key: "review-tier", grade: "agent-forbidden" },
    ];
    assert.deepEqual(parseProtectedPropertyLines(formatProtectedPropertyLines(list)), list);
  });

  test("bare keys read as agent-forbidden; blanks and comments skipped; raw grades preserved", () => {
    assert.deepEqual(parseProtectedPropertyLines("steward\n\n# note\nfoo: authority-conferring\nbar: bogus"), [
      { key: "steward", grade: "agent-forbidden" },
      { key: "foo", grade: "authority-conferring" },
      { key: "bar", grade: "bogus" }, // preserved raw; normalization drops it at registry-set time
    ]);
  });

  test("canonicalPropertyKey", () => {
    assert.equal(canonicalPropertyKey("  Auto_Accept "), "auto-accept");
  });
});
