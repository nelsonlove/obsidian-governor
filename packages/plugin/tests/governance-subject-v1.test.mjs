/**
 * governance-subject-v1.test.mjs — WP3, the canonical-subject security contract.
 *
 * D13's words, because they set the bar: "Signatures and full-coverage
 * verification are meaningful only when every producer computes the same
 * subject bytes. This is a security contract, not a convenience serializer."
 * So these tests are about DETERMINISM and REFUSAL — same input in any order
 * produces identical bytes, and anything outside the version-1 domain is
 * refused with a stable error identifier rather than serialized on a guess.
 *
 * The golden fixture (fixtures/governance-subject-v1.json) is committed and
 * every entry is recomputed here. It exists for cross-runtime confidence: the
 * digest implementation runs identically in Node and Obsidian's desktop
 * renderer today, and the pinned digests catch any future divergence rather
 * than absorbing it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalize, NoncanonicalValueError } from "../src/governor/kernel/contracts/canonical-json.ts";
import { digestUtf8, digestBytes, isSha256Digest } from "../src/governor/kernel/contracts/digest.ts";
import {
  buildProposalItemSubject,
  buildCohortSubject,
  subjectDigest,
  SubjectInvalidError,
  SubjectDuplicateError,
  SubjectUnsupportedVersionError,
  PROPOSAL_ITEM_SCHEMA,
} from "../src/governor/kernel/contracts/subject-v1.ts";
import { sortClasses, governingClass, escalate, CHANGE_CLASSES } from "../src/governor/kernel/contracts/change-class.ts";
import { mintId, isUuidV7 } from "../src/governor/kernel/contracts/ids.ts";
import { ORIGIN_CONFIDENCE, originRecord } from "../src/governor/kernel/contracts/origin.ts";
import { STATE_AXES } from "../src/governor/kernel/contracts/states.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── shared fixture pieces ────────────────────────────────────────────────────

const d = (text) => digestUtf8(text);

/** A complete, valid proposal-item input. Tests override fields from here. */
function itemInput(over = {}) {
  return {
    vaultId: "vault-1",
    noteId: "note-abc",
    path: "Notes/A.md",
    pathSemanticallyRelevant: false,
    base: d("before"),
    proposed: d("after"),
    attachments: [],
    sideEffects: [],
    changeClasses: ["content"],
    transformation: { id: "edit", version: "1" },
    predicates: [{ id: "diff-complete", version: "1" }],
    producingOperation: { id: "op-1", action: "note.write", actionVersion: 1 },
    observations: [{ id: "obs-1", digest: d("seen"), capture: "replayable" }],
    sessionId: "sess-1",
    mandateId: null,
    ...over,
  };
}

// ── canonical JSON — RFC 8785 over the version-1 domain ──────────────────────

describe("canonical JSON — determinism", () => {
  test("object keys sort by UTF-16 code units, recursively", () => {
    assert.equal(canonicalize({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  });

  test("key order in the INPUT is irrelevant to the output", () => {
    const one = canonicalize({ alpha: 1, beta: [true, null], gamma: "x" });
    const two = canonicalize({ gamma: "x", beta: [true, null], alpha: 1 });
    assert.equal(one, two);
  });

  test("UTF-16 order, not code-point order — the RFC's own edge", () => {
    // "\u{1D306}" (surrogate pair, first unit 0xD834) sorts BEFORE ""
    // in code points but AFTER it in UTF-16 code units? No: 0xD834 < 0xE000,
    // so the pair sorts first in UTF-16 too. The discriminating pair is
    // "ﬀ" (single unit 0xFB00) vs "\u{1D306}" (first unit 0xD834): code
    // points say FB00 < 1D306, UTF-16 says D834 < FB00. RFC 8785 wants UTF-16.
    const out = canonicalize({ "ﬀ": 1, "\u{1D306}": 2 });
    assert.ok(out.indexOf("\u{1D306}") < out.indexOf("ﬀ"), "surrogate-pair key sorts first under UTF-16 order");
  });

  test("array order is PRESERVED — order is meaning, builders sort, serializer must not", () => {
    assert.equal(canonicalize([3, 1, 2]), "[3,1,2]");
  });

  test("string escaping matches JSON.stringify, which RFC 8785 adopts", () => {
    const s = 'quote " backslash \\ newline \n control  unicode é';
    assert.equal(canonicalize(s), JSON.stringify(s));
  });

  test("no insignificant whitespace anywhere", () => {
    assert.equal(canonicalize({ a: [1, "b"], c: true }), '{"a":[1,"b"],"c":true}');
  });
});

describe("canonical JSON — the refused domain", () => {
  const refuse = (v) => assert.throws(() => canonicalize(v), NoncanonicalValueError);

  test("floats are refused — version-1 manifests contain no floating point", () => {
    refuse(1.5);
    refuse({ n: 0.1 });
  });

  test("negative and unsafe integers are refused", () => {
    refuse(-1);
    refuse(Number.MAX_SAFE_INTEGER + 1);
  });

  test("NaN and Infinity are refused", () => {
    refuse(NaN);
    refuse(Infinity);
  });

  test("undefined is refused — absence is explicit null, never omission by accident", () => {
    refuse(undefined);
    refuse({ a: undefined });
  });

  test("a sparse array is refused, not emitted as invalid JSON — review finding 5", () => {
    // eslint-disable-next-line no-sparse-arrays
    refuse([1, , 3]);
  });

  test("non-plain objects are refused rather than serialized on a guess", () => {
    refuse(new Date(0));
    refuse(new Map());
    class X {}
    refuse(new X());
  });

  test("the refusal carries the stable code and the path to the offender", () => {
    try {
      canonicalize({ ok: 1, bad: { deep: 1.5 } });
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.code, "noncanonical");
      assert.match(e.at, /bad\/deep/);
    }
  });
});

// ── digests — exact bytes, no normalization ──────────────────────────────────

describe("digest — exact UTF-8 bytes", () => {
  test("known vector: sha256('abc')", () => {
    assert.equal(digestUtf8("abc").value, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("digestBytes and digestUtf8 agree on the same bytes", () => {
    assert.deepEqual(digestBytes(new TextEncoder().encode("héllo")), digestUtf8("héllo"));
  });

  test("NO Unicode normalization: composed and decomposed é digest differently", () => {
    // "é" as U+00E9 vs "e"+U+0301 render identically and are DIFFERENT bytes.
    // The subject covers bytes; normalizing would let two producers disagree
    // about what was signed while both believe they hashed the same note.
    const composed = "café";
    const decomposed = "café";
    assert.equal(composed.normalize("NFC"), decomposed.normalize("NFC"), "sanity: they normalize equal");
    assert.notEqual(digestUtf8(composed).value, digestUtf8(decomposed).value);
  });

  test("isSha256Digest accepts the real thing and rejects near-misses", () => {
    assert.ok(isSha256Digest(digestUtf8("x")));
    assert.ok(!isSha256Digest({ algorithm: "sha256", value: "short" }));
    assert.ok(!isSha256Digest({ algorithm: "sha1", value: "a".repeat(64) }));
    assert.ok(!isSha256Digest({ algorithm: "sha256", value: "A".repeat(64) }), "uppercase hex is not canonical");
  });
});

// ── proposal-item builder ────────────────────────────────────────────────────

describe("proposal-item subject — canonical form", () => {
  test("a valid input builds, stamped with the v1 schema", () => {
    const s = buildProposalItemSubject(itemInput());
    assert.equal(s.schema, PROPOSAL_ITEM_SCHEMA);
  });

  test("every sortable array is sorted regardless of input order", () => {
    const s = buildProposalItemSubject(
      itemInput({
        attachments: [
          { id: "b", digest: d("2") },
          { id: "a", digest: d("1") },
        ],
        sideEffects: [
          { kind: "link", target: "z", digest: null },
          { kind: "link", target: "a", digest: null },
          { kind: "create", target: "m", digest: d("m") },
        ],
        changeClasses: ["content", "encoding", "structural"],
        predicates: [
          { id: "p2", version: "1" },
          { id: "p1", version: "2" },
          { id: "p1", version: "1" },
        ],
        observations: [
          { id: "obs-2", digest: d("b"), capture: "evidence" },
          { id: "obs-1", digest: d("a"), capture: "replayable" },
        ],
      })
    );
    assert.deepEqual(s.attachments.map((a) => a.id), ["a", "b"]);
    assert.deepEqual(s.sideEffects.map((x) => `${x.kind}:${x.target}`), ["create:m", "link:a", "link:z"]);
    assert.deepEqual(s.changeClasses, ["encoding", "structural", "content"], "canonical six-class order");
    assert.deepEqual(s.predicates.map((p) => `${p.id}@${p.version}`), ["p1@1", "p1@2", "p2@1"]);
    assert.deepEqual(s.observations.map((o) => o.id), ["obs-1", "obs-2"]);
  });

  test("two differently-ordered inputs digest identically — the whole point", () => {
    const a = buildProposalItemSubject(
      itemInput({
        predicates: [
          { id: "p2", version: "1" },
          { id: "p1", version: "1" },
        ],
        changeClasses: ["content", "presentation"],
      })
    );
    const b = buildProposalItemSubject(
      itemInput({
        changeClasses: ["presentation", "content"],
        predicates: [
          { id: "p1", version: "1" },
          { id: "p2", version: "1" },
        ],
      })
    );
    assert.deepEqual(subjectDigest(a), subjectDigest(b));
  });

  test("an ephemeral observation is refused — it cannot support a proposal (D16)", () => {
    assert.throws(
      () => buildProposalItemSubject(itemInput({ observations: [{ id: "o", digest: d("x"), capture: "ephemeral" }] })),
      (e) => e instanceof SubjectInvalidError && e.code === "subject_invalid"
    );
  });

  test("null is explicit absence: creation has base null, ungoverned path is null", () => {
    const s = buildProposalItemSubject(itemInput({ base: null, path: null }));
    assert.equal(s.base, null);
    assert.equal(s.path, null);
    assert.match(canonicalize(s), /"base":null/);
    assert.match(canonicalize(s), /"path":null/);
  });

  test("duplicate attachment ids are refused, not deduplicated", () => {
    assert.throws(
      () =>
        buildProposalItemSubject(
          itemInput({
            attachments: [
              { id: "a", digest: d("1") },
              { id: "a", digest: d("2") },
            ],
          })
        ),
      (e) => e instanceof SubjectDuplicateError && e.code === "subject_duplicate"
    );
  });

  test("a structurally malformed item refuses with the stable code, not a TypeError", () => {
    // Reachable through the cohort rebuild path, which feeds arbitrary
    // runtime items into this builder — a missing array field must still be
    // `subject_invalid`, because callers dispatch on the code.
    const noArrays = { ...itemInput() };
    delete noArrays.attachments;
    assert.throws(() => buildProposalItemSubject(noArrays), (e) => e.code === "subject_invalid");
    const cohortSmuggle = { ...buildProposalItemSubject(itemInput()) };
    delete cohortSmuggle.changeClasses;
    assert.throws(
      () => buildCohortSubject({ items: [cohortSmuggle], resolvedScope: { include: [], exclude: [] }, excludedProposalIds: [], recoveryUnit: "item" }),
      (e) => e.code === "subject_invalid"
    );
  });

  test("invalid inputs are refused with the stable identifier", () => {
    for (const bad of [
      itemInput({ vaultId: "" }),
      itemInput({ proposed: { algorithm: "sha256", value: "nope" } }),
      itemInput({ changeClasses: ["cosmetic"] }),
      itemInput({ producingOperation: { id: "op", action: "a", actionVersion: 0 } }),
    ]) {
      assert.throws(() => buildProposalItemSubject(bad), (e) => e.code === "subject_invalid");
    }
  });
});

// ── cohort builder ───────────────────────────────────────────────────────────

describe("cohort subject — canonical form", () => {
  const item = (noteId, over = {}) => buildProposalItemSubject(itemInput({ noteId, ...over }));

  function cohortInput(over = {}) {
    return {
      items: [item("n2"), item("n1")],
      resolvedScope: { include: ["Notes/"], exclude: ["Notes/private/"] },
      excludedProposalIds: [],
      recoveryUnit: "item",
      ...over,
    };
  }

  test("items sort by noteId, then proposed digest, then path with null first", () => {
    const c = buildCohortSubject(
      cohortInput({
        items: [
          item("n2", { path: "b.md" }),
          item("n1", { proposed: d("zzz") }),
          item("n0", { path: null }),
        ],
      })
    );
    assert.deepEqual(c.items.map((i) => i.noteId), ["n0", "n1", "n2"]);
  });

  test("null path sorts before any string path on the tie", () => {
    // Same noteId is rejected, so the tie is exercised via the sort comparator
    // ordering two items that differ only in proposed digest and path.
    const a = item("n1", { proposed: d("same"), path: null, vaultId: "v-a" });
    const b = item("n1", { proposed: d("same"), path: "A.md", vaultId: "v-b" });
    const c = buildCohortSubject(cohortInput({ items: [b, a] }));
    assert.equal(c.items[0].path, null);
  });

  test("duplicate note identity is refused — silent dedup would keep a copy nobody chose", () => {
    assert.throws(
      () => buildCohortSubject(cohortInput({ items: [item("n1"), item("n1", { proposed: d("other") })] })),
      (e) => e instanceof SubjectDuplicateError && e.code === "subject_duplicate"
    );
  });

  test("an item claiming a different schema version is refused with the stable identifier", () => {
    const alien = { ...item("n1"), schema: "governor.proposal-item/v2" };
    assert.throws(
      () => buildCohortSubject(cohortInput({ items: [alien] })),
      (e) => e instanceof SubjectUnsupportedVersionError && e.code === "subject_unsupported_version"
    );
  });

  test("scope include/exclude and exclusions are sorted; duplicate exclusions refused", () => {
    const c = buildCohortSubject(
      cohortInput({ resolvedScope: { include: ["b/", "a/"], exclude: [] }, excludedProposalIds: ["p2", "p1"] })
    );
    assert.deepEqual(c.resolvedScope.include, ["a/", "b/"]);
    assert.deepEqual(c.excludedProposalIds, ["p1", "p2"]);
    assert.throws(
      () => buildCohortSubject(cohortInput({ excludedProposalIds: ["p1", "p1"] })),
      (e) => e.code === "subject_duplicate"
    );
  });

  test("a NON-ADJACENT duplicate is refused — review finding 1", () => {
    // Sorting by noteId/proposed/path can interleave one vault's duplicate
    // pair with another vault's item: [v1/nA d-low, v2/nA d-mid, v1/nA d-high]
    // sorts with the two v1 copies apart, and an adjacency scan misses them.
    // The check is a set over (vaultId, noteId), so position cannot matter.
    const ds = ["p1", "p2", "p3"].map((t) => d(t)).sort((a, b) => (a.value < b.value ? -1 : 1));
    const items = [
      item("nA", { vaultId: "v1", proposed: ds[0] }),
      item("nA", { vaultId: "v2", proposed: ds[1] }),
      item("nA", { vaultId: "v1", proposed: ds[2] }),
    ];
    assert.throws(() => buildCohortSubject(cohortInput({ items })), (e) => e.code === "subject_duplicate");
  });

  test("the item order is TOTAL — same set, any input order, identical digest (review finding 2)", () => {
    // Two items tying on (noteId, proposed, path) but from different vaults
    // used to fall through to input order under the stable sort — same item
    // set, two different canonical byte streams. vaultId is the deterministic
    // tie-breaker D13 requires.
    const a = item("nA", { vaultId: "v1", proposed: d("same"), path: null, base: null });
    const b = item("nA", { vaultId: "v2", proposed: d("same"), path: null, base: null });
    const one = subjectDigest(buildCohortSubject(cohortInput({ items: [a, b] })));
    const two = subjectDigest(buildCohortSubject(cohortInput({ items: [b, a] })));
    assert.deepEqual(one, two);
  });

  test("cohort items are REVALIDATED, not trusted — review finding 3", () => {
    // A runtime caller can hand the cohort builder anything: a JSON-parsed
    // item skips the item builder entirely. Rebuilding inside the cohort
    // builder re-runs every item rule — here, D16's ephemeral rejection.
    const smuggled = {
      ...item("nA"),
      observations: [{ id: "o", digest: d("x"), capture: "ephemeral" }],
    };
    assert.throws(() => buildCohortSubject(cohortInput({ items: [smuggled] })), (e) => e.code === "subject_invalid");
  });

  test("extra properties on a digest never reach canonical bytes — review finding 4", () => {
    const dirty = { algorithm: "sha256", value: d("x").value, extra: "leak" };
    const s = buildProposalItemSubject(itemInput({ proposed: dirty, base: dirty, attachments: [{ id: "a", digest: dirty }] }));
    const bytes = canonicalize(s);
    assert.ok(!bytes.includes("extra"), "the leaked key is stripped by rebuild");
    assert.ok(!bytes.includes("leak"));
    // And through the cohort path too, where items are rebuilt:
    const c = buildCohortSubject(cohortInput({ items: [{ ...s, proposed: dirty }] }));
    assert.ok(!canonicalize(c).includes("leak"));
  });

  test("EXCLUSIONS CHANGE THE DIGEST — leaving an item out is a different decision", () => {
    const base = buildCohortSubject(cohortInput());
    const excl = buildCohortSubject(cohortInput({ excludedProposalIds: ["p-9"] }));
    assert.notEqual(subjectDigest(base).value, subjectDigest(excl).value);
  });
});

// ── change classes ───────────────────────────────────────────────────────────

describe("change classes — registry and escalation", () => {
  test("the canonical order is the adopted six, lowest authority first", () => {
    assert.deepEqual([...CHANGE_CLASSES], ["encoding", "presentation", "representation", "structural", "content", "authority"]);
  });

  test("the highest applicable class governs admission", () => {
    assert.equal(governingClass(["presentation", "content"]), "content");
    assert.equal(governingClass(["encoding"]), "encoding");
    assert.equal(governingClass([]), null, "no classes = a read; reads are not admitted");
  });

  test("uncertainty escalates, never downgrades", () => {
    assert.equal(escalate("presentation", "authority"), "authority");
    assert.equal(escalate("authority", "presentation"), "authority");
  });

  test("sortClasses dedupes and orders canonically", () => {
    assert.deepEqual(sortClasses(["content", "encoding", "content"]), ["encoding", "content"]);
  });
});

// ── ids, origins, states — the smaller contracts ─────────────────────────────

describe("ids — UUIDv7 minting", () => {
  test("minted ids are well-formed UUIDv7", () => {
    const rand = new Uint8Array(10).fill(7);
    const id = mintId("session", 1_700_000_000_000, rand);
    assert.ok(isUuidV7(id), id);
  });

  test("minting is deterministic under injected randomness — and time-ordered", () => {
    const rand = new Uint8Array(10).fill(1);
    assert.equal(mintId("cohort", 1000, rand), mintId("cohort", 1000, rand));
    assert.ok(mintId("cohort", 1000, rand) < mintId("cohort", 2000, rand), "UUIDv7 sorts by mint time");
  });
});

describe("origins — confidence is fixed per class", () => {
  test("each origin carries exactly the certainty the runtime provides", () => {
    assert.equal(ORIGIN_CONFIDENCE["governor-originated"], "bound");
    assert.equal(ORIGIN_CONFIDENCE["local-human-observed"], "observed");
    assert.equal(ORIGIN_CONFIDENCE["sync-attributed"], "attributed");
    assert.equal(ORIGIN_CONFIDENCE["external-unattributed"], "indeterminate");
  });

  test("originRecord carries the mapping so a record is readable alone", () => {
    assert.deepEqual(originRecord("sync-attributed"), { origin: "sync-attributed", confidence: "attributed" });
  });
});

describe("states — five axes, not one list", () => {
  test("all five axes exist with their normative values", () => {
    assert.deepEqual(Object.keys(STATE_AXES), ["development", "verification", "authority", "record", "operational"]);
    assert.ok(STATE_AXES.authority.includes("admitted"));
    assert.ok(STATE_AXES.verification.includes("stale"));
  });
});

// ── the committed golden fixture ─────────────────────────────────────────────

describe("golden fixture — cross-runtime digests", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "governance-subject-v1.json"), "utf8"));

  test("the fixture is non-trivial", () => {
    assert.ok(fixture.entries.length >= 6, `expected at least 6 golden entries, got ${fixture.entries.length}`);
  });

  for (const entry of JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "governance-subject-v1.json"), "utf8")).entries) {
    test(`golden: ${entry.name}`, () => {
      const canonical = canonicalize(entry.subject);
      assert.equal(canonical, entry.canonical, "canonical bytes match the committed form");
      assert.equal(digestUtf8(canonical).value, entry.digest, "digest matches the committed value");
      assert.deepEqual(subjectDigest(entry.subject), { algorithm: "sha256", value: entry.digest });
    });
  }

  test("content digests in the fixture are byte-exact over their declared text", () => {
    for (const probe of fixture.contentProbes) {
      assert.equal(digestUtf8(probe.text).value, probe.digest, probe.name);
    }
  });
});
