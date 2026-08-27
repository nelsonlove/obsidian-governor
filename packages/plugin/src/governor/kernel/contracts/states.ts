// STATES — the five separate state axes (WP3).
//
// "State" is not one list. A note can be development-ready, verification-stale,
// authority-admitted, record-working, and operationally-idle all at once, and
// collapsing those into one status field is how the old model lost the
// distinction between "a human approved this" and "the machinery finished".
// The vocabulary doc (Five separate state axes) is the normative source; each
// axis answers a different question and no value on one axis implies a value
// on another.

/** How mature is the work? */
export type DevelopmentState = "draft" | "ready" | "revision-requested";
export const DEVELOPMENT_STATES: readonly DevelopmentState[] = ["draft", "ready", "revision-requested"];

/** Which predicates cover the exact subject? */
export type VerificationState = "unverified" | "running" | "passed" | "failed" | "stale";
export const VERIFICATION_STATES: readonly VerificationState[] = ["unverified", "running", "passed", "failed", "stale"];

/** What has standing? */
export type AuthorityState = "ungoverned" | "proposed" | "admitted" | "superseded" | "revoked";
export const AUTHORITY_STATES: readonly AuthorityState[] = ["ungoverned", "proposed", "admitted", "superseded", "revoked"];

/** How is it retained? */
export type RecordState = "working" | "snapshot" | "frozen" | "archived";
export const RECORD_STATES: readonly RecordState[] = ["working", "snapshot", "frozen", "archived"];

/** What is the machinery doing? */
export type OperationalState = "queued" | "running" | "blocked" | "completed";
export const OPERATIONAL_STATES: readonly OperationalState[] = ["queued", "running", "blocked", "completed"];

/** The five axes together, for records that carry a full state snapshot. */
export interface StateAxes {
  development: DevelopmentState;
  verification: VerificationState;
  authority: AuthorityState;
  record: RecordState;
  operational: OperationalState;
}

export const STATE_AXES = {
  development: DEVELOPMENT_STATES,
  verification: VERIFICATION_STATES,
  authority: AUTHORITY_STATES,
  record: RECORD_STATES,
  operational: OPERATIONAL_STATES,
} as const;
