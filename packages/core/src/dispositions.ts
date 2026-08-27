// ============================================================================
//  THE DISPOSITION SUBSTRATE (#221, phase 2 — extracted from #228's
//  governor/kernel/dispositions.ts; published here at the suite split's S3,
//  condition 9)
// ----------------------------------------------------------------------------
//  A triage instance = a queue predicate + a disposition set. A disposition is
//  DECLARED as a descriptor — `{ id, authority, surface, label, effect, … }` —
//  and the instance's surfaces (pane controls, MCP tools, docs) render FROM
//  the declared table, so "what dispositions exist, and who may exercise
//  each" is a reviewable data table, not knowledge scattered across call
//  sites.
//
//  THE AUTHORITY AXIS (the one rule, applied uniformly): a disposition that
//  CONFERS STANDING — that decides what enters or leaves the accepted
//  knowledge base — is `authority: "human"` and exists ONLY as a
//  gesture-gated pane control, never an API. A mechanical, reversible write
//  is `authority: "agent"` and exists ONLY as an ordinary guarded MCP tool.
//
//  Two instances declare against this shape today:
//    - the ACCEPTANCE instance (governor/kernel/dispositions.ts, the
//      governance PROVIDER) — the review pane's seven verbs, mixed
//      human/agent authority;
//    - the INBOX-TRIAGE instance (kernel/triage/descriptors.ts, HOST — a
//      future satellite plugin) — THREE mechanical primitives (trash / move /
//      stamp), ALL agent authority (none confers standing), no pane surface at
//      all. Anything richer is a human-declared config row, not a built-in.
//      (This said "ten verbs" until S3a. That was the pre-#241 table; Nelson's
//      2026-08-19 ruling replaced it with the three primitives — see
//      docs/triage.md. The stale count rode along on the move into this
//      package, where a wrong number would have shipped as documentation of a
//      published contract.)
//
//  PUBLISHED HERE (@vault-mcp/core) rather than living in either subtree: the
//  provider's dispositions module type-imported this shape from the host's
//  `kernel/triage/dispositions.ts`, but triage is destined to become its own
//  SATELLITE plugin (§6) — the governance provider must not depend on a
//  satellite. Only this GENERIC shape (the descriptor interface and its three
//  pure helpers) is shared; the triage-specific content — the built-in
//  primitive table, the merged-table logic, config, queue predicate, planner
//  — stays host-side in `kernel/triage/`, and the acceptance-specific content
//  — the closed id/surface unions, the frozen seven-verb table, the
//  accept-effect display text — stays with the provider in
//  `governor/kernel/dispositions.ts`. Both instance modules import this
//  shape from here instead of from one another.
//
//  Substrate rules, inherited by every instance:
//
//    - Descriptors are pure DATA. No callable rides a descriptor: `effect` is
//      a documentation string, not a function — an accept-capable callable on
//      module-exported data would be exactly the app-walkable accept gadget
//      the governance reachability invariant forbids.
//    - Instance tables are FROZEN. No registry / plugin API adds a
//      disposition at runtime; extending a set is a reviewed code change.
//    - Pure data + pure helpers — headless-testable.
//
//  The generic type is parameterized on the instance's own id and surface
//  unions, so each instance keeps a CLOSED id set (an unknown id is a type
//  error at the declaration site, and `byId` returns undefined at runtime).
// ============================================================================

/** Who may exercise a disposition. "human" ⇒ gesture-gated pane control ONLY
 * (the standing-conferring class); "agent" ⇒ guarded MCP tool ONLY (the
 * mechanical, reversible class). */
export type DispositionAuthority = "human" | "agent";

/**
 * The generic descriptor every instance's dispositions declare. `Id` and
 * `Surface` are the instance's own closed unions (e.g. the acceptance
 * instance's seven ids over five surfaces; the triage instance's three ids over
 * the one "mcp-tool" surface). Instances may EXTEND this shape with their own
 * data fields (the triage table adds effect-mapping metadata) — extensions
 * must stay plain data, per the substrate rules above.
 */
export interface DispositionDescriptorShape<Id extends string = string, Surface extends string = string> {
  readonly id: Id;
  /** Who may exercise it — see DispositionAuthority. */
  readonly authority: DispositionAuthority;
  /** Where it surfaces (instance-defined union; "mcp-tool" by convention for
   * an agent verb). */
  readonly surface: Surface;
  /** Button text (human) / display label (agent). */
  readonly label: string;
  /** One-line effect description — documentation + log/PR vocabulary, never a
   * callable. */
  readonly effect: string;
  /** Human only: additionally confirmation-gated behind a modal. */
  readonly confirm?: boolean;
  /** Human only: captures free text in a modal before acting. */
  readonly input?: boolean;
  /** True when the disposition mutates NOTHING: exempt from gesture gating. */
  readonly stateless?: boolean;
}

/** The descriptors of one surface, in declared (render) order. */
export function dispositionsForSurface<D extends DispositionDescriptorShape>(
  set: ReadonlyArray<D>,
  surface: D["surface"],
): D[] {
  return set.filter((d) => d.surface === surface);
}

/** Lookup by id — undefined for an unknown id (every instance's set is
 * closed). */
export function dispositionByIdIn<D extends DispositionDescriptorShape>(
  set: ReadonlyArray<D>,
  id: D["id"],
): D | undefined {
  return set.find((d) => d.id === id);
}

/**
 * The human dispositions of a set that MUTATE state — exactly the class that
 * must be gesture-gated (addEventListener + isRealGesture, never
 * `.onclick =`). Stateless verbs are exempt; agent dispositions are never
 * pane controls at all. An all-agent instance (inbox triage) gets the empty
 * set — correctly: nothing there needs a gesture, because nothing there
 * confers standing.
 */
export function gestureGatedIn<D extends DispositionDescriptorShape>(set: ReadonlyArray<D>): D[] {
  return set.filter((d) => d.authority === "human" && !d.stateless);
}
