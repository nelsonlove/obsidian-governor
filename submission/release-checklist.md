# Community Plugin release checklist

Use **Initial submission** once and **Every release** for each version. A checked box requires evidence tied to the release commit; this document itself does not claim the check has passed.

Official references:

- [Developer policies](https://docs.obsidian.md/community-directory/developer-policies)
- [Submission requirements for plugins](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)
- [Submit your plugin](https://docs.obsidian.md/plugins/releasing/submit-plugin)
- [Manifest reference](https://docs.obsidian.md/Reference/Manifest)
- [Plugin self-critique checklist](https://docs.obsidian.md/oo/plugin)

## Initial submission

### Repository and ownership

- [ ] GitHub repository is accessible to the Community directory review process.
- [ ] Default branch contains source corresponding to the release.
- [ ] Maintainer's Obsidian account is linked to the correct GitHub account.
- [ ] Community directory owner is selected and has ongoing support responsibility.
- [ ] Real issue tracker, support route, and private security-reporting route are configured and monitored.
- [ ] Repository is not an unapproved fork under current policy.

### Required root files

- [ ] `README.md` explains purpose, setup, use, safety, privacy, desktop-only status, and support.
- [ ] `LICENSE` exists, is recognized, and matches source/dependency obligations.
- [ ] `manifest.json` is committed at the location processed by the directory.
- [ ] `SECURITY.md` contains a real private reporting route.
- [ ] `PRIVACY.md` matches bundle data flows.
- [ ] Relative README links and images resolve from the public listing context.

### Product boundary

- [ ] Every public surface resolves a versioned registered action and invokes the shared operation executor.
- [ ] Registry, handlers, bindings, capability projection, and bundle agree in both directions.
- [ ] Substantive governed-session reads are replayable by default; eligible plumbing reads declare ephemeral capture explicitly.
- [ ] Clean-vault setup works without private vault policy, scheme, vocabulary, or agent fleet.
- [ ] Fresh install begins Looking only with no content scope.
- [ ] Create/append and structural mutation are separately enabled.
- [ ] Human acceptance and Governor-only admission have no agent-accessible bypass.
- [ ] Sessions bind actor, scope, base, mandate, expiry, and receipts durably.
- [ ] Individual and grouped decisions use immutable exact subjects.
- [ ] Mandates name delegate, scope, class, transformation, limits, verifier, admission mode, expiry, and recovery.
- [ ] A mandate can be counter-proposed by an agent but activated, widened, renewed, or revoked only through the human surface.
- [ ] Private packs are absent from the Community bundle.
- [ ] Permanent delete, generic command/arbitrary code, plugin lifecycle, destructive import, unconstrained outside-vault export, and authority restoration are absent publicly.

### Disclosures

- [ ] Network use is described; core local-only behavior is verified against the bundle.
- [ ] Outside-vault operational files and their purpose are described.
- [ ] Local Git storage, signer/key metadata, attestations, and portable-standing Sync data are described.
- [ ] Replayable observation content, replica-local storage, playback authorization, retention, export, deletion, and non-portability by default are described.
- [ ] Obsidian Sync is described as file-level transport, not atomic transaction or backup.
- [ ] No client-side telemetry exists.
- [ ] Any server-side telemetry is absent or disclosed with a linked privacy policy.
- [ ] Account and payment requirements are accurately stated.
- [ ] Closed-source components, if any, are disclosed and approved through the applicable process.
- [ ] Desktop-only behavior and mobile note availability are explained.

### Official code-quality review

- [ ] Sample plugin classes, names, commands, settings, and unused examples are removed.
- [ ] Command IDs do not redundantly include the plugin id.
- [ ] Commands have no default hotkeys.
- [ ] UI uses sentence case and accessible Obsidian components.
- [ ] Styling is scoped and not hard-coded inline.
- [ ] Global `app`, deprecated APIs, unsafe casts, and unnecessary `any` are reviewed.
- [ ] User paths use `normalizePath` plus Governor boundary checks.
- [ ] Configuration directory uses `Vault.configDir`, not a hard-coded `.obsidian`.
- [ ] Background writes use supported safe APIs.
- [ ] Properties use `FileManager.processFrontMatter`.
- [ ] Recoverable deletion uses `trashFile`.
- [ ] Settings use plugin data APIs.
- [ ] Startup defers heavy UI work and supports required deferred views.
- [ ] Every event, interval, view, socket, hidden leaf, DOM handler, and child component cleans up.

### Security evidence

- [ ] Path traversal and segment-boundary tests pass.
- [ ] Hidden-path and stable-address scope tests pass.
- [ ] Acceptance frontmatter parity and encoded-content tests pass.
- [ ] Protected-property introduction/change/removal tests pass.
- [ ] Opaque and dynamic output paths are absent or fail closed.
- [ ] Record protection and documented residuals are verified.
- [ ] Revision, simultaneous retry, mismatch, timeout, and late-correction tests pass.
- [ ] External read-only trust and pathless mutation tests pass.
- [ ] Scope filtering and redaction occur before observation capture.
- [ ] Ephemeral observations cannot support proposals, verification, or admission.
- [ ] Replay payload integrity, authorization, historical playback, expiry, and deletion tests pass.
- [ ] No surface or compatibility binding can bypass the operation executor or overstate its evidence.
- [ ] Journal failure produces degraded audit without false rollback.
- [ ] Prompt-injection fixtures cannot widen authority or confer acceptance.
- [ ] Caller-supplied actor, Git author, signer, and verifier identities are ignored or refused.
- [ ] Change-class classification and escalation tests pass.
- [ ] Mandate scope, class, transformation, budgets, expiry, revocation, and replay tests pass.
- [ ] Cohort canonicalization prevents future or excluded items from entering an accepted decision.
- [ ] DSSE envelope, in-toto subject/predicate, trust, stale, and revocation tests pass.
- [ ] Direct Git standing-ref advancement is unreachable outside admission.
- [ ] Partial and reordered Sync arrivals remain receiving and never partially admitted.
- [ ] Sync conflict or merge creates a new subject requiring verification.

### Performance and product evidence

- [ ] Startup and layout-ready work are measured.
- [ ] First connection and capability construction are measured.
- [ ] Evidence/replay capture and playback cost are measured for representative result sizes.
- [ ] Large-vault search, review refresh, and identity behavior are measured.
- [ ] Cohort freeze, verification, drill-down, and admission are measured at release-scale item counts.
- [ ] Git ingestion/diff/bundle and attestation import/validation are measured.
- [ ] Two-replica Sync behavior is recorded with community-plugin data on and off.
- [ ] Foreground and occluded Bases behavior are measured when included.
- [ ] Connect/disconnect and hidden-view cleanup show no material leak.
- [ ] Keyboard and assistive-technology review is recorded.
- [ ] A new evaluator completes getting started without maintainer assistance.
- [ ] Uninstall leaves notes readable and documents remaining plugin state.

### Migration closure

- [ ] Old plugin/product client registrations are repointed.
- [ ] Old acceptance or stewardship writer is inactive.
- [ ] Old macros or commands that confer standing are disabled.
- [ ] Operational state is migrated or retained intentionally.
- [ ] Backup restoration is verified.
- [ ] Git history and portable attestation restoration are verified without inventing historical signatures.
- [ ] Current docs contain one public product identity.
- [ ] Contradictions register records and resolves remaining historical claims.
- [ ] Dated closure record is signed by the release owner.

### Submission release

- [ ] Manifest version is semantic `x.y.z`.
- [ ] `minAppVersion` equals the oldest tested compatible version.
- [ ] `isDesktopOnly` is `true`.
- [ ] Name and id meet current manifest rules and are unique in the submission interface.
- [ ] Description is at most 250 characters, action-oriented, and ends with a period.
- [ ] GitHub release tag matches manifest version exactly.
- [ ] Release contains `main.js`, `manifest.json`, and `styles.css` only when used.
- [ ] Default branch HEAD contains the accurate submitted manifest.
- [ ] Submission form is completed through community.obsidian.md.
- [ ] Automated guidance is addressed through a new semantic version when a release change is required.

## Every release

### Source and versions

- [ ] Release commit is identified and reviewed.
- [ ] Workspace tests and production build succeed from the committed lock file.
- [ ] Manifest, package metadata, version map, tag, release name, assets, and status record agree.
- [ ] New dependencies and transitive changes are licensed and audited.
- [ ] Changelog or release notes explain user-visible, security, privacy, compatibility, and migration changes.

### Bundle inspection

- [ ] `main.js` is built from the release commit and minimized without concealment.
- [ ] Bundle contains no secrets, personal paths, unexpected hosts, telemetry, dynamic loaders, test fixtures, or debug logs.
- [ ] Private/server packages and excluded capabilities are absent.
- [ ] Source maps are omitted or reviewed for unintended content.
- [ ] Asset digests are recorded.

### Regression evidence

- [ ] Pure, guard-integration, and package test suites pass.
- [ ] Security perimeter regression suite passes.
- [ ] Optional dependencies are tested in available and unavailable states.
- [ ] Changed live adapters are exercised in supported Obsidian versions.
- [ ] Performance budgets for changed paths remain satisfied or the release documents the decision.
- [ ] Review, receipt, privacy, and uninstall journeys still match documentation.
- [ ] Session, mandate, cohort, admission, revocation, Git, attestation, and Sync journeys still match documentation.

### Documentation and policy

- [ ] Action, capability, settings, error, operation/observation/effect receipt, status, and compatibility projections match their owners.
- [ ] README, SECURITY, PRIVACY, threat model, and data flow match bundle behavior.
- [ ] New network, outside-vault, account, payment, telemetry, or closed-source behavior is disclosed before release.
- [ ] Official Obsidian policy and submission sources were re-opened for changes.
- [ ] Local Markdown links pass.
- [ ] No stale product name, version, or static tool-count claim entered current docs.

### Migration and rollback

- [ ] Migration dry run and supported-predecessor tests pass.
- [ ] Consumers are repointed and predecessor writers disabled.
- [ ] Backup and rollback procedure are verified.
- [ ] Irreversible state or authority changes are explicit.
- [ ] Closure record is complete.

### Publish and monitor

- [ ] Matching release assets are uploaded under the new tag.
- [ ] Clean-vault installation from release assets succeeds.
- [ ] Community directory detects the release or a manual recheck is requested.
- [ ] Safety scorecard is reviewed and actionable findings are resolved.
- [ ] Support and security channels are monitored after publication.
- [ ] Rollback trigger and maintainer are available during the monitoring window.

## Release blocking conditions

Do not publish when:

- acceptance or scope can be bypassed;
- a public capability is opaque, unbounded, or missing recovery;
- an executable action is unregistered, a surface bypasses the operation executor, or a projection disagrees with runtime;
- replay capture can cross scope, unauthorized playback succeeds, or an ephemeral observation can support authority;
- mutation outcome or journal state is falsely reported;
- required evidence is absent;
- private code or undisclosed network behavior appears in the bundle;
- versions or release assets disagree;
- migration leaves two active authorities;
- clean-vault onboarding fails; or
- security/support reporting destinations are unmonitored.

Checking a box without retained evidence does not satisfy the gate.
