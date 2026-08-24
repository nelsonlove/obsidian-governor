# Standing and attestations

> [!note] Target-state document
> This page describes the target product. Not every behavior below is shipped — what IS shipped is owned by [Current release state](status-and-compatibility.md#current-release-state).

Governor separates four questions:

1. What bytes or structure were proposed?
2. Who or what claims to have produced them?
3. Which checks were performed against the exact result?
4. Why does that result have standing?

Git records content and transitions. Signed attestations record claims about exact content. Mandates establish delegated authority. Admission establishes standing.

## Standing

**Standing** means Governor currently treats an exact subject as authoritative for the purpose named by its policy. A file's mere presence in the vault does not establish standing.

Standing may arise from:

- a direct human acceptance gesture over an exact proposal or cohort; or
- Governor admission under a valid human mandate after every required predicate passes.

Standing may be superseded, revoked, or invalidated by later changes. It does not rewrite history.

## Acceptance and admission

**Acceptance** is the human authority act (owned by [Review and safety](review-and-safety.md); restated here for flow). It can be contemporaneous—a click on a verified cohort—or prospective—a signed mandate for a bounded class of verified results.

**Admission** is Governor's mechanical transition that records that an exact subject satisfied the applicable human authority and now has standing.

An authoring agent can neither accept nor admit. It may submit a proposal, request verification, or draft a mandate for the human to consider.

Admission itself is a Governor-only authority operation. It resolves a registered admission action, validates the exact subject and authority chain, records the admission attestation, and advances standing. No agent-facing surface binds to that action.

## Identity: labels are not credentials

Git author and committer names are descriptive metadata. They are not authentication and are not used as Governor authority.

Governor derives the actor binding from the connection and session it issued. The client does not supply the authoritative actor field on a mutation. Human-readable labels may appear in receipts, but keys and trusted local gestures establish identity for attestations.

The rule is:

> Names describe. Keys identify. Attestations claim. Mandates authorize. Governor admits.

## Attestation types

Governor uses separate attestations so one actor cannot blur several roles.

### Proposal attestation

States which operation and session produced a proposal manifest, its action version, base, transformation, class, durable supporting observations, observed effects, and claimed intent. It does not claim correctness or authority.

### Mandate attestation

Records the human's accepted delegation: delegate binding, scope, classes, limits, verifier policy, admission mode, expiry, and revocation reference.

### Verification attestation

States that a named verification operation applied a named predicate to an exact subject and records pass, fail, or incomplete results. It binds the verifier, predicate, supporting durable observation digests, coverage, and freshness. A new subject digest requires new verification.

### Admission attestation

States that Governor admitted an exact proposal or cohort because a direct human gesture or valid mandate and required verification were present.

### Effect receipt

Records that an adapter applied or observed the admitted result in a particular local vault replica, including partial or uncertain state. Effect is not standing; it is evidence about realization.

### Observation evidence

Records what Governor returned or observed at its own boundary, at evidence or replayable durability. Observation evidence can support a proposal or verifier predicate, but it is not an authority claim and does not make a result standing. Ephemeral observations are intentionally excluded from authority dependencies.

## Subject binding

Every attestation names an immutable subject digest computed from a versioned canonical manifest independent of Git commit serialization.

Each proposal item contains:

- subject-schema version;
- vault and stable note identity;
- path when it is required for display or is semantically relevant to the predicate;
- base and proposed content digests;
- relevant attachment and side-effect digests;
- exact change class or allowed combination;
- transformation id and version;
- required verifier predicate ids and versions;
- proposal-producing operation id and action version;
- supporting observation digests when the claim depends on observed state;
- session and mandate references when applicable; and
- explicit absence markers for optional fields.

A cohort contains the exact item manifests in deterministic order, plus its resolved scope, exclusions, recovery unit, and cohort-schema version. Canonical UTF-8 serialization fixes Unicode handling, field order, numbers, arrays, and absent fields. A change to any canonicalization rule creates a new schema version and digest. Git object ids may be supporting evidence, but they are not the complete authority subject.

Changing any item, adding a later session result, excluding a failure, or resolving a Sync conflict produces a new subject digest. Old attestations remain historical and no longer validate the new subject.

## DSSE and in-toto shape

Governor follows the design of in-toto statements wrapped in a DSSE-style signed envelope. The goal is interoperability and disciplined separation, not a claim of certification by the in-toto project.

A verification statement has this conceptual shape:

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [
    {
      "name": "governor:cohort:01J...",
      "digest": {
        "sha256": "<canonical-cohort-manifest-digest>"
      }
    }
  ],
  "predicateType": "https://governor.local/attestation/verification/v1",
  "predicate": {
    "verifier": {
      "id": "governor.schema-preservation",
      "version": "<verifier-version>",
      "keyid": "<registered-key-id>"
    },
    "policy": "representation.description-carrier/v1",
    "result": "pass",
    "coverage": {
      "items": 600,
      "verified": 600,
      "failed": 0,
      "excluded": 0
    },
    "checks": [
      "frontmatter prose field absent",
      "required body section present",
      "normalized source and destination text equal",
      "unrelated properties and body regions unchanged"
    ],
    "assurance": "deterministic-full-coverage",
    "observedAt": "<timestamp>"
  }
}
```

The statement is encoded as the DSSE payload and signed:

```json
{
  "payloadType": "application/vnd.in-toto+json",
  "payload": "<base64-encoded statement>",
  "signatures": [
    { "keyid": "<registered-key-id>", "sig": "<signature>" }
  ]
}
```

The signature covers the payload type and payload according to DSSE. Governor validates the envelope, trusted key, predicate type, subject digest, policy version, expiry, and revocation state before relying on the claim.

## Admission rule

Admission succeeds only when:

1. the subject exists and its digest matches current content;
2. the proposal's base and class are valid;
3. all required verification attestations cover that exact subject;
4. every verifier key and predicate is trusted by the mandate or direct review policy;
5. the human gesture or mandate is valid, unexpired, and not revoked;
6. scope, item, byte, class, and failure budgets are satisfied;
7. no item is uncertain, conflicted, or partially verified; and
8. Governor records a new admission attestation and advances standing atomically in its local ledger.

If any condition is unknown, the subject remains proposed.

## Separation of roles

For content and authority changes, the default is that the author does not serve as the sole verifier. For deterministic encoding, presentation, representation, or structural rules, Governor's independently versioned verifier may provide full-coverage evidence.

The policy names allowed combinations. “The same agent says it looks right” is not independent verification.

The minimum verifier separation is:

| Change class | Minimum independence |
|---|---|
| Encoding | Deterministic, separately versioned verifier; it may run inside Governor's process |
| Presentation | Deterministic semantic or structured comparator separately versioned from the author |
| Representation | Transformation-specific, separately versioned verifier covering the complete source and destination |
| Structural | Separately versioned identity, link, scope, and recovery verifier using live Obsidian state |
| Content | Human substantive decision or separately bound qualified reviewer; the author is never the sole verifier |
| Authority | Human gesture or mandate plus Governor policy validation; never author-verified |

Separate versioning identifies the predicate implementation and fixtures independently of the authoring agent or prompt. It does not imply process or machine isolation. A hardened profile may require a separate process, key, or device.

## Revocation and supersession

Revocation never deletes old attestations. Governor appends a revocation that names:

- the mandate, key, verifier policy, or admitted subject revoked;
- the human or policy authority for revocation;
- effective time;
- reason; and
- replacement, if any.

A later proposal may supersede an admitted subject, but it does not gain standing until separately admitted.

## Standing through moves, deletion, and restoration

- A Governor-admitted rename or move creates a structural transition. Stable identity and content standing carry only after path-dependent policy, collection, link, scope, and recovery checks pass.
- An external or Sync rename creates a new current subject. Standing follows only after the transition is verified and admitted.
- A missing or deleted file retains its historical admissions but has current state `missing` or `suspended`; absence is not rewritten as revocation.
- Restoring exact previously admitted bytes records a new effect and revalidates current policy. It does not revive an expired or revoked mandate.
- Restoring different bytes or path-sensitive meaning creates a new subject requiring new verification and admission.

## Historical cutover

Portable standing begins prospectively. Existing acceptance properties, baselines, and review history may be imported as `legacy-import` evidence with their source and known timestamp, but Governor does not fabricate human signatures, verification predicates, or admission attestations for them.

The human may re-accept selected current subjects or frozen legacy cohorts. Those new decisions establish portable standing from the cutover forward without erasing the older local evidence.

## Storage and portability

Attestations are small, immutable, content-addressed records. The local Git store may index them with Git refs or notes. A portable ledger may carry them between devices without trusting filenames, modification times, Git author strings, or mutable status files.

The logical envelope set is canonical. Each replica writes only to its own append-only segment or partition; reconciliation performs set union by envelope digest and then validates signatures, subjects, expiry, and revocation. Mutable indexes are rebuildable projections and never authority. The first portable release performs no destructive compaction. A later checkpoint may summarize earlier segments but cannot erase revocation or provenance meaning.

## Signing is not vault encryption

Governor does not encrypt notes, attachments, Git history, or the vault. Digital signatures identify which registered device or verifier issued an exact claim. Each authorized device or verifier role has its own private signing key in operating-system protected secret storage; private keys never enter notes, Git, journals, ordinary settings, or Obsidian Sync.

Adding a device requires an explicit human pairing gesture. An optional encrypted recovery export protects only the private-key backup and stays outside the live vault and Sync remote. Losing a key without that export requires registering a new key and revoking the old one; Governor never recreates its identity or backdates signatures.

## Stable interoperability boundary

Governor promises versioned compatibility for canonical subjects and digest algorithms, attestation envelopes and predicate identifiers, key and signature identifiers, revocation and checkpoint semantics, exported Governor bundles, standard Git objects, and a read-only standing export or API.

Internal Git ref names, journal layout, mutable indexes, caches, UI state, queue/idempotency storage, and module-operational records are implementation details. External tools may inspect standard Git data and stable exports but may not advance Governor standing refs.

See [Git, Sync, and portability](git-and-sync.md) for cross-device behavior.

## Verification limits

- A valid signature proves possession of a key, not truth of the claim.
- A trusted verifier proves only its named predicate.
- A passing predicate can be wrong if its implementation, inputs, or policy are wrong.
- A mandate can authorize a bad rule; budgets and review reduce but do not erase that risk.
- Same-user compromise can steal keys or alter local runtime state unless a hardened deployment adds stronger isolation.

Attestations make authority and evidence inspectable. They do not replace judgment, backups, or a threat model.

Primary design references: [in-toto Attestation Framework](https://github.com/in-toto/attestation/blob/main/spec/README.md), [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md), [in-toto Predicate v1](https://github.com/in-toto/attestation/blob/main/spec/v1/predicate.md), [in-toto Envelope](https://github.com/in-toto/attestation/blob/main/spec/v1/envelope.md), and [DSSE background](https://github.com/secure-systems-lab/dsse/blob/master/background.md).
