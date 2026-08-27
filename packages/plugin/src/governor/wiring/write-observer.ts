// THE PROPOSAL-PRODUCING WRITE OBSERVER — the governance provider's registrant
// on the host's seam (`registerWriteObserver`, src/mcp/seam.ts).
//
// This is WP6b-1's producer, unchanged in what it decides and moved in where it
// lives. Until S2 it was an inline `propose:` closure inside `mcp/server.ts` —
// the host's transport file holding the provider's class firewall, proposal
// builder, mandate policy and history recording, which is precisely the
// coupling the suite split exists to remove. It now runs BEHIND the seam: the
// host reports the exact bytes of a completed write, and everything downstream
// of that report is provider-internal and reachable from nowhere else.
//
// The division of labour with the host, stated because it is easy to blur:
//
//   HOST      decides WHEN — an operation completed, the backend reported its
//             base/proposed bytes, and those facts describe THIS operation's
//             path (the write-facts slot and its attribution guard stay in
//             server.ts, because they protect the host's own bookkeeping).
//   PROVIDER  decides WHETHER — the action is the native write, the human
//             turned history on, the store is wired, the diff actually changes
//             something, and the write fits a mandate.
//
// Failure posture is unchanged and is the reason this is an OBSERVER and never
// a veto: a proposal is a candidate, and losing one must never cost a caller
// their write. Everything here degrades — a mandate resolution failure proposes
// UNSTAMPED, a recording failure proposes NOTHING, and a throw is caught by the
// seam's dispatcher, off the caller's result path entirely.

import type { WriteFacts } from "../../mcp/seam.js";
import { NOTE_WRITE_V1 } from "../../kernel/operations/actions/note-write.js";
import {
  deriveClasses,
  requireClassesCovered,
  authorityKeysDiffer,
  frontmatterUid,
} from "../kernel/proposals/class-firewall.js";
import { buildProposalSubjectFromOperation } from "../kernel/proposals/proposal-builder.js";
import { openProposal, type ProposalV1 } from "../kernel/proposals/proposal.js";
import { productionStampOf } from "../kernel/mandates/policy.js";
import { digestBytes } from "../kernel/contracts/digest.js";
import type { MandateV1 } from "../kernel/mandates/mandate.js";
import type { MandateUsage } from "../kernel/mandates/budgets.js";

/**
 * Everything the producer needs, injected. Note what is NOT here: no `app`, no
 * settings object, no plugin instance. The observer is handed thunks over the
 * provider's own stores by the composition root, so it stays headlessly
 * testable and holds no capability it was not given.
 */
export interface WriteObserverDeps {
  /** The human's history switch (D10). False ⇒ nothing is produced. */
  historyEnabled: () => boolean;
  proposals: {
    open(proposal: ProposalV1, now: number): Promise<void>;
    /** The note's stable uid from the metadata cache, when it has one. */
    uidOf(path: string): string | null;
    vaultId: string;
    /**
     * Record base+proposed snapshots; the recording ref, or null when the path
     * is outside the effective history scope.
     */
    record(
      proposalId: string,
      path: string,
      baseBytes: Uint8Array | null,
      proposedBytes: Uint8Array
    ): Promise<string | null>;
  };
  /**
   * The session's governing mandate, for producer stamping (WP10b). Typed
   * structurally over the one field this needs, so the producer does not
   * import the session contract to read a string.
   */
  sessions?: {
    get(sessionId: string): Promise<{ mandateId: string | null } | null>;
  };
  mandates?: {
    getMandate(id: string): Promise<MandateV1 | null>;
    usageOf(id: string): Promise<MandateUsage>;
    chargeAndObserve(id: string, delta: { items: number; proposals: number; bytes: number }): Promise<void>;
  };
  now?: () => number;
}

/**
 * Build the observer. The returned function is what `registerWriteObserver`
 * takes — its return value is ignored by the seam, and nothing on a caller's
 * result path awaits it.
 */
export function createProposalObserver(deps: WriteObserverDeps): (facts: WriteFacts) => Promise<void> {
  const clock = deps.now ?? (() => Date.now());

  return async function observeWrite(facts: WriteFacts): Promise<void> {
    // WHETHER, first half: this producer speaks for exactly one action. A
    // different action's write is somebody else's contract, not an unstamped
    // one — silence is the correct answer.
    if (facts.operation.action !== NOTE_WRITE_V1.id) return;
    if (deps.historyEnabled() !== true) return;

    // Class firewall (classification rule 5): classes DERIVED from the diff,
    // declaration must cover them. pathChanged is false because this surface
    // writes at a fixed path (a move is a different action); authority-key
    // changes ARE derivable here — the accept guard refuses introducing or
    // changing accepted keys, but REMOVING them or downgrading
    // acceptance-status passes it and changes standing, so the diff is
    // inspected rather than assumed clean. An authority-shaped diff fails
    // coverage below and the proposal is skipped — the write stands; the
    // legacy queue still governs it.
    const dec = new TextDecoder();
    const baseText = facts.baseBytes === null ? null : dec.decode(facts.baseBytes);
    const proposedText = dec.decode(facts.proposedBytes);
    const derived = deriveClasses({
      baseBytes: facts.baseBytes,
      proposedBytes: facts.proposedBytes,
      pathChanged: false,
      touchesAuthorityKeys: authorityKeysDiffer(baseText, proposedText),
    });
    requireClassesCovered(NOTE_WRITE_V1.changeClasses, derived);
    if (derived.length === 0) return; // a byte-identical rewrite proposes nothing

    // Identity: the uid from the EXACT written bytes first (the metadata cache
    // lags a create), the cache for pre-existing uids, the honest path fallback
    // last — never invented.
    const uid = frontmatterUid(proposedText) ?? deps.proposals.uidOf(facts.path);
    const proposalSession = facts.operation.sessionId ?? "no-session";
    const now = clock();

    // WP10b: the producer's mandate stamp. If this connection's session runs
    // under a mandate and the write FITS it (productionStampOf — the pure
    // decision, exhaustively pinned in its own suite), the subject carries the
    // mandate id and the budgets are charged. An unfit write proposes UNSTAMPED
    // — a mandate grants, it never blocks production — and any resolution
    // failure degrades to unstamped with a console error, because a proposal is
    // safe and losing one to mandate plumbing would not be.
    let stampedMandateId: string | null = null;
    let stampCharge: { mandateId: string; delta: { items: number; proposals: number; bytes: number } } | null = null;
    try {
      if (facts.operation.sessionId && deps.sessions && deps.mandates) {
        const sess = await deps.sessions.get(facts.operation.sessionId);
        const governing = sess?.mandateId ?? null;
        if (governing !== null) {
          const mandate = await deps.mandates.getMandate(governing);
          const usage = await deps.mandates.usageOf(governing);
          const decision = productionStampOf(
            mandate,
            usage,
            {
              delegate: {
                sessionId: facts.operation.sessionId,
                connection: facts.actor.connection,
                role: null,
              },
              notePath: facts.path,
              changeClasses: derived,
              transformation: { id: NOTE_WRITE_V1.id, version: String(NOTE_WRITE_V1.version) },
              predicates: [{ id: "content-diff", version: "1" }],
              action: { id: NOTE_WRITE_V1.id, version: String(NOTE_WRITE_V1.version) },
              durability: "replayable",
            },
            facts.proposedBytes.byteLength,
            now
          );
          stampedMandateId = decision.mandateId;
          if (decision.mandateId !== null && decision.charge !== null) {
            stampCharge = { mandateId: decision.mandateId, delta: decision.charge };
          }
        }
      }
    } catch (e) {
      console.error("[governor] mandate stamp resolution failed; proposing unstamped", e);
      stampedMandateId = null;
      stampCharge = null;
    }

    const proposal = openProposal(
      {
        subject: buildProposalSubjectFromOperation({
          vaultId: deps.proposals.vaultId,
          noteId: uid ?? `path:${facts.path}`,
          path: facts.path,
          pathSemanticallyRelevant: false,
          base: facts.baseBytes === null ? null : digestBytes(facts.baseBytes),
          proposed: digestBytes(facts.proposedBytes),
          changeClasses: derived,
          transformation: { id: NOTE_WRITE_V1.id, version: String(NOTE_WRITE_V1.version) },
          predicates: [{ id: "content-diff", version: "1" }],
          producingOperation: {
            id: facts.operation.id,
            action: facts.operation.action,
            actionVersion: facts.operation.actionVersion,
          },
          observations: [], // a write's subject needs no read observation; capture is uncoupled (D16)
          sessionId: proposalSession,
          mandateId: stampedMandateId,
        }),
        sessionId: proposalSession,
      },
      now
    );

    // Snapshots FIRST, proposal second — a proposal without its recording is
    // permanently unverifiable (base bytes die with the write), so a failed or
    // out-of-scope recording skips the proposal rather than opening a dead one.
    const recordingRef = await deps.proposals.record(proposal.id, facts.path, facts.baseBytes, facts.proposedBytes);
    if (recordingRef === null) return;
    await deps.proposals.open({ ...proposal, recordingRef }, now);
    // The charge lands only after the stamped proposal durably opened — counted
    // work is work that exists. A failed charge under-counts, which is LOUD
    // here and healed by the door's own budget check (the belt).
    if (stampCharge !== null && deps.mandates) {
      try {
        await deps.mandates.chargeAndObserve(stampCharge.mandateId, stampCharge.delta);
      } catch (e) {
        console.error("[governor] mandate budget charge after stamped proposal FAILED — usage is under-counted", e);
      }
    }
  };
}
