// CUTOVER MARKER ↔ STORE BINDING — the restore-truth fix (governor-lead's
// ruling, 2026-08-23, sharpened twice; both prior designs died to one fact).
//
// THE INVARIANT, stated once, plainly: **anything that travels with the
// vault cannot prove which machine is authoritative.** The cutover marker
// (cutover.json) travels — Sync, the vault backup, every restore. The
// standing chain does not (machine-local, its own backup). So a restored or
// synced replica reads `cutOver: true` beside an empty chain and answers
// "nothing admitted" — a true statement about a store that isn't there,
// indistinguishable from "nothing was ever accepted", at exactly the moment
// (disaster recovery) the system's answers most need to be true.
//
// The binding: the marker carries the identity of the STORE it authorizes —
// a store-id that lives INSIDE the machine-local history dir. The id travels
// with the #337 chain backup and with nothing else, which is the correct
// asymmetry: restoring the chain backup restores the id and re-authorizes
// (restore-is-restore); restoring only the vault yields a marker naming a
// store this machine does not have, and the verdict below says so out loud.
//
// Two rules with no exceptions, each the grave of a rejected design:
//   * The id is minted ONLY inside a gestured act (the cutover itself, or
//     the explicit bind gesture) — never on read, never on load. A
//     lazily-minted id is a replica looking bound. (First rejected design:
//     install-id — it lives in the vault's plugin dir and RESTORES WITH the
//     marker; you cannot distinguish an original from a copy using only
//     things that were copied.)
//   * An unbound marker is NEVER auto-adopted. Adoption writes into the
//     travelling record — a replica stamping itself would de-authorize the
//     real chain — and it grants authority with no human gesture: the
//     accept verb with no hand on it. (Second rejected design.) The unbound
//     state is reported, and ONE gesture-gated control binds it: a human is
//     the only discriminator that is not vault-resident.

import type { CutoverStateV1 } from "./cutover.js";
import { CutoverRefusedError } from "./cutover.js";

export type BindingVerdict =
  | { state: "pre-cutover" }
  | { state: "bound"; storeId: string }
  | {
      /** The marker predates the binding era (or was written by an older build): cutOver true, no storeId. Reported, never auto-adopted; the bind gesture resolves it. */
      state: "marker-unbound";
      detail: string;
    }
  | {
      /** The marker names a store this machine does not hold — the restored-replica / synced-replica case. */
      state: "store-mismatch";
      markerStoreId: string;
      localStoreId: string | null;
      detail: string;
    };

/**
 * Pure verdict over the marker and the LOCAL store's id. Reads only — this
 * function (and every read path above it) must never mint.
 */
export function bindingVerdict(cutover: CutoverStateV1, localStoreId: string | null): BindingVerdict {
  if (!cutover.cutOver) return { state: "pre-cutover" };
  const marker = cutover.storeId ?? null;
  if (marker === null) {
    return {
      state: "marker-unbound",
      detail:
        "the cutover marker names no authorized store (it predates the binding era). This machine's admission answers are not authoritative until a human binds the chain — " +
        "use the gesture-gated “bind this machine's chain” control on the machine that holds the real chain. An unbound marker is never adopted automatically.",
    };
  }
  if (localStoreId === marker) return { state: "bound", storeId: marker };
  return {
    state: "store-mismatch",
    markerStoreId: marker,
    localStoreId,
    detail:
      `cut over elsewhere; chain absent here. The marker authorizes store ${marker.slice(0, 12)}… and this machine holds ` +
      (localStoreId === null ? "no store identity" : `store ${localStoreId.slice(0, 12)}…`) +
      " — this vault copy is a replica or a restore without its chain. Admission answers here are NOT evidence that nothing was admitted. " +
      "Restore the chain backup onto this machine (which restores the authorized identity), or work on the machine that holds the chain.",
  };
}

/** The io port for the machine-local store id — a file INSIDE the history dir, so it rides the chain backup and nothing else. */
export interface StoreIdIo {
  read(): Promise<string | null>;
  write(id: string): Promise<void>;
}

/**
 * Mint-or-read the local store id — callable ONLY from inside a gestured act
 * (the cutover, or the bind gesture). The gestureRef parameter is not
 * decoration: requiring it here makes a mint outside a gesture a type-level
 * and review-level anomaly, and the tests pin that no read path calls this.
 */
export async function mintStoreIdGestured(io: StoreIdIo, gestureRef: string, mint: () => string): Promise<string> {
  if (!gestureRef) throw new CutoverRefusedError("authority_missing", "a store identity is minted only inside a gestured act");
  const existing = await io.read();
  if (existing !== null) return existing;
  const id = mint();
  await io.write(id);
  return id;
}
