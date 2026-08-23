# Contributing to Governor

Governor welcomes focused improvements to safety, usability, compatibility, documentation, and bounded capability. Because it mediates AI access to personal notes, contributions are reviewed for consequences beyond whether the code works on the happy path.

## Before you start

1. Read [Architecture](docs/architecture.md), [Threat model](docs/threat-model.md), and [Developer guide](docs/developer-guide.md).
2. Search existing issues and status records for the same problem.
3. Use a dedicated test vault.
4. For a new capability or architectural change, agree on the user outcome and public/private boundary before implementation.
5. Do not mix an unrelated cleanup or migration into the same change.

## Repository workflow

Work on a feature branch or isolated worktree, keep commits scoped to one logical change, and open a pull request. Do not push feature work directly to the release branch.

The project should configure its real issue, pull-request, security, and conduct links before publication. This target-state pack describes the workflow without inventing repository automation that has not been verified.

## Change categories

### Documentation-only

May clarify an existing owner without changing product behavior. Verify links, terminology, and source status. A public guarantee cannot be introduced through prose alone.

### Read capability

Must still address path scope, hidden-result disclosure, truncation, unavailable dependencies, performance, and third-party data flow.

### Mutation capability

Must include preview, guarded registration, session, computed change class, mandate eligibility, cohort behavior, queue, Git transition, revision, retries, protected data, journal, class-specific verification, attestations, receipt, recovery, review consequence, and Sync-replica behavior.

### Security-boundary change

Includes scope, accepted-family recognition, admission, sessions, mandates, signers, verifiers, attestations, Git refs, portable standing, protected properties, opaque operations, external trust, local bridge, secrets, or release supply chain. It requires an independent security-focused review and adversarial tests.

### Migration or deprecation

Must follow [Migration and deprecation](docs/migration-and-deprecation.md). Leaving both old and new authorities alive is a blocking defect.

## Capability proposal

Before code, describe:

- user outcome;
- who needs it;
- why an existing bounded operation cannot provide it;
- public, optional, private, or excluded distribution;
- access mode, semantic change class or allowed combinations, and consequence overlay;
- session, mandate, cohort, verifier, attestation, and replica behavior;
- scope and data flow;
- preview and recovery;
- availability dependencies;
- errors and degraded behavior;
- review impact; and
- documentation and migration owners.

Use the [Action registry](docs/action-registry.md) for the semantic contract and the generated [Capability projection](docs/capability-manifest.md) for audience/distribution consequences.

## Implementation rules

- Keep deterministic logic in pure TypeScript.
- Keep Obsidian coupling in small live adapters.
- Use supported Obsidian APIs and lifecycle registration.
- Register every action once and route every surface through the shared operation executor.
- Do not create a generic escape hatch when a dedicated operation can state the postcondition.
- Never expose acceptance, admission, signer selection, mandate activation, or standing-ref advancement to agents.
- Never trust caller-supplied actor identity or Git author strings.
- Preserve user annotations and unknown content unless the change explicitly owns them.
- Return unknown rather than zero when the host cannot support a claim.
- Report partial and uncertain state honestly.
- Keep high-authority or opaque behavior out of the public distribution.

## Tests required by change

| Change | Minimum evidence |
|---|---|
| Parser or planner | Pure fixtures, malformed input, boundary cases |
| Read action/capability | Scope-before-capture, hidden totals, capture level, replay integrity when applicable, truncation, dependency unavailable |
| Content write | Preview/apply parity, revision conflict, retry identity, protected properties, verification, receipt |
| Structural write | Source/destination scope, collision, partial failure, link-aware live behavior, recovery |
| External capability | Publisher identity, untrusted read-only assertion, pathless mutation refusal |
| Review behavior | Gesture-only authority, attribution, race, queue budget, stale/superseded state |
| Mandate/cohort | Session binding, immutable subject, scope/class/budget/expiry, counter-proposal, revocation, exact group decision |
| Git/attestation | Object/ref integrity, subject canonicalization, signatures, verifier trust, admission, bundle recovery |
| Sync/replica | Partial ordering, portable state on/off, conflict, receiving state, no partial admission |
| Security fix | Regression fixture plus neighboring variants of the same defect class |
| Release change | Bundle inspection, manifest/release match, clean-vault install, rollback |

Run the workspace test suite and plugin production build:

```bash
npm test --workspaces --if-present
npm --workspace packages/plugin run build
```

Record live test conditions instead of writing “tested manually.”

## Pull-request description

Include:

- outcome and rationale;
- action-registry and capability-projection changes;
- operation, observation, and effect contract changes;
- public/private impact;
- threat-model and data-flow impact;
- tests and live evidence;
- degraded-mode results;
- migration and rollback;
- documentation changed or generated; and
- known residuals.

If a field does not apply, explain why.

## Review expectations

Reviewers focus on:

- correctness of the postcondition;
- scope and authority containment;
- acceptance and protected-property invariants;
- session identity, mandate, verifier, attestation, standing, and replica invariants;
- supported Obsidian API usage;
- concurrency, timeout, retry, and partial-state behavior;
- data disclosure and retention;
- recovery;
- migration closure;
- documentation ownership; and
- unnecessary capability or dependency growth.

Pure style comments should not obscure correctness and safety findings.

Security-sensitive and acceptance-path changes require review from someone who did not author the implementation. Release maintainers should require two independent verdicts for critical perimeter changes when operationally available.

## Documentation contributions

Follow the [Documentation basis](docs/documentation-basis.md):

- label historical and proposed material accurately;
- cite primary official sources for external requirements;
- do not turn implementation evidence into a public guarantee without status review;
- do not duplicate manifest or settings facts by hand;
- preserve the public vocabulary;
- update contradictions rather than deleting historical evidence; and
- run the local-link and terminology checks.

## Dependencies

Prefer fewer dependencies. A new dependency needs:

- clear outcome it enables;
- license review;
- lock-file update;
- supply-chain and telemetry review;
- bundle impact;
- platform compatibility;
- update ownership; and
- removal plan.

Dependencies that add client-side telemetry, hidden network behavior, obfuscation, or self-installation are incompatible with the public Community Plugin policy.

## Release and migration discipline

Do not call a feature done when only code has merged. Complete:

- build and deployment path;
- consumer repointing;
- predecessor deactivation;
- state migration;
- backup verification;
- post-cutover audit;
- documentation and compatibility status;
- contradiction resolution; and
- dated closure evidence.

See [Testing and release](docs/testing-and-release.md).

## Conduct

Be respectful, protect private user data, and disclose conflicts of interest. The actual publication repository must adopt and link its enforceable code of conduct and reporting channel before accepting outside contributions.
