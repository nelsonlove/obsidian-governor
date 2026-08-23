// AUTHORITY CUTOVER — WP8, D14 Gate 1.
//
// The single highest-stakes transition in Gate 1: the moment legacy stops
// being authoritative. Before it, standing is the in-vault baselines; after
// it, standing is the admission chain. The design commitments, each pinned:
//
// - ONE human-confirmed act. The cutover requires a gesture ref minted by
//   the accept surface's gate, and an import report from an actual import
//   run — cutting over a legacy-bearing vault without importing its evidence
//   is the skipped-step mistake this refuses.
// - THE FLAG WRITE IS THE ONLY EFFECT. Authority is wherever the persisted
//   state says it is; a crash anywhere in the flow leaves the flag unwritten
//   and legacy still authoritative. The fail direction is stated, not
//   implied: half-landed means LEGACY-STILL-AUTHORITATIVE, never
//   both-or-neither.
// - ROLLBACK EXISTS while the predecessor is read-only. Rolling back is
//   another human-confirmed flag write — it re-enables the legacy writers
//   and needs nothing from them to run (a rollback that required the
//   disabled system to act would be unusable exactly when needed).
// - The disabled writer REFUSES, it is not merely unreferenced: the
//   BaselineStore checks this state on every write (see baseline-store.ts's
//   writeAllowed guard), so "only one standing writer is active" is a
//   runtime property, not a code-review observation.

import type { LegacyImportReport } from "./legacy-import.js";

export interface CutoverStateV1 {
  v: 1;
  cutOver: boolean;
  /** When the cutover was confirmed, and by which gesture. Null until it happens. */
  at: number | null;
  gestureRef: string | null;
  /** The import report presented at confirmation — what the human saw. */
  importReport: LegacyImportReport | null;
  /** Set when a rollback un-cut the vault. */
  rolledBackAt: number | null;
  /** The gesture that authorised the rollback — recorded like the cutover's own (review finding: a validated-then-discarded ref records the act nowhere). */
  rollbackGestureRef?: string | null;
  /** The identity of the machine-local store this marker authorizes (store-binding.ts's invariant: the marker travels with the vault, the chain does not — this field is what lets a replica or a restore say "cut over elsewhere" instead of "nothing admitted"). Absent on pre-binding markers; set only inside a gestured act. */
  storeId?: string | null;
}

export const CUTOVER_DEFAULT: CutoverStateV1 = { v: 1, cutOver: false, at: null, gestureRef: null, importReport: null, rolledBackAt: null };

export class CutoverRefusedError extends Error {
  constructor(
    readonly code: string,
    detail: string
  ) {
    super(`cutover refused [${code}]: ${detail}`);
    this.name = "CutoverRefusedError";
  }
}

export class LegacyWriterDisabledError extends Error {
  readonly code = "legacy_writer_disabled";
  constructor(op: string) {
    super(
      `Error [legacy_writer_disabled]: ${op} is disabled — the authority cutover has run and standing advances only through admission. ` +
        "Roll back the cutover (a human-confirmed act) to re-enable legacy baseline writes."
    );
    this.name = "LegacyWriterDisabledError";
  }
}

/** Persisted-state port: read returns the default when nothing is stored; write is atomic-per-call. */
export interface CutoverStore {
  read(): Promise<CutoverStateV1>;
  write(state: CutoverStateV1): Promise<void>;
}

/**
 * Perform the cutover. Refuses without a gesture, without an import report,
 * or when already cut over. The returned state HAS been persisted — a write
 * failure throws and leaves authority with legacy (the fail direction).
 */
export async function performCutover(store: CutoverStore, gestureRef: string, importReport: LegacyImportReport, storeId: string, now: number): Promise<CutoverStateV1> {
  if (!gestureRef) throw new CutoverRefusedError("authority_missing", "the cutover is a human act; it requires the gesture reference minted by the gate");
  if (!importReport) throw new CutoverRefusedError("import_missing", "no import report presented — run the legacy evidence import first, even if it reports zero records");
  if (!storeId) throw new CutoverRefusedError("store_unbound", "the cutover binds the marker to this machine's store identity; minting that identity happens inside this same gesture (store-binding.ts) — an unbound cutover would recreate the restore-lie the binding exists to close");
  const cur = await store.read();
  if (cur.cutOver) throw new CutoverRefusedError("already_cut_over", `the cutover already ran at ${cur.at}; nothing further to cut`);
  const next: CutoverStateV1 = { v: 1, cutOver: true, at: now, gestureRef, importReport, rolledBackAt: null, storeId };
  await store.write(next);
  return next;
}

/**
 * Bind a pre-binding-era marker (cutOver true, no storeId) to this machine's
 * store — the ONE human act that resolves the marker-unbound state. Refuses
 * on anything else: never a rebind (a mismatched marker is a different,
 * bigger decision this act deliberately cannot make), never automatic.
 */
export async function bindMarker(store: CutoverStore, gestureRef: string, storeId: string, now: number): Promise<CutoverStateV1> {
  if (!gestureRef) throw new CutoverRefusedError("authority_missing", "binding the chain is a human act; it requires the gesture reference minted by the gate");
  if (!storeId) throw new CutoverRefusedError("store_unbound", "no store identity to bind");
  const cur = await store.read();
  if (!cur.cutOver) throw new CutoverRefusedError("not_cut_over", "no cutover marker to bind");
  if (cur.storeId) {
    throw new CutoverRefusedError(
      cur.storeId === storeId ? "already_bound" : "bound_elsewhere",
      cur.storeId === storeId
        ? "the marker is already bound to this store"
        : `the marker is bound to store ${cur.storeId.slice(0, 12)}… — re-binding authority to a different machine is not this control's act; restore the authorized chain instead`
    );
  }
  const next: CutoverStateV1 = { ...cur, storeId };
  await store.write(next);
  return next;
}

/**
 * Roll the cutover back — legacy becomes authoritative again. A human act
 * with the same gate discipline. Requires nothing from the disabled legacy
 * machinery: it is a flag write, usable while the predecessor is read-only.
 */
export async function rollbackCutover(store: CutoverStore, gestureRef: string, now: number): Promise<CutoverStateV1> {
  if (!gestureRef) throw new CutoverRefusedError("authority_missing", "the rollback is a human act; it requires the gesture reference minted by the gate");
  const cur = await store.read();
  if (!cur.cutOver) throw new CutoverRefusedError("not_cut_over", "the cutover has not run; there is nothing to roll back");
  const next: CutoverStateV1 = { ...cur, cutOver: false, rolledBackAt: now, rollbackGestureRef: gestureRef };
  await store.write(next);
  return next;
}
