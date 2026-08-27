// MANDATE DRAFTS — agent-authored requests and counter-proposals (WP9).
//
// A draft is the negotiation half of bounded delegation: an agent (or
// Governor itself, spotting that requested authority exceeds the available
// verifier or recovery path) writes down EXACT terms and hands them to the
// human. A draft confers NOTHING — it is a candidate, in the #221 sense, and
// the only thing that turns it into authority is the human's activation
// gesture in the pane.
//
// A COUNTER-PROPOSAL is a new draft that narrows or reshapes another
// (`counterOf`). Countering supersedes the countered draft — the human sees
// the latest terms, with the chain preserved as provenance. "An agent cannot
// interpret continued conversation, silence, or prior approval as acceptance
// of a changed mandate": nothing in this module reads assent from anywhere.

import { mintId } from "../contracts/ids.js";
import { MandateRefusedError, cloneTerms, termsInvalidReason, type MandateTerms } from "./mandate.js";

export type MandateDraftStatus = "open" | "superseded" | "activated" | "declined";

export interface MandateDraftV1 {
  schema: "governor.mandate-draft/v1";
  /** Draft ids share the mandate mint (UUIDv7); the schema field keeps the object kinds distinct. */
  id: string;
  /** Who authored the request — provenance, never authority. */
  authoredBy: { sessionId: string | null; client: string | null };
  /** The draft this one narrows/reshapes, or null for an original request. */
  counterOf: string | null;
  requestedAt: number;
  terms: MandateTerms;
  status: MandateDraftStatus;
  /** Present only on declined drafts. */
  declinedReason?: string;
}

export interface DraftInput {
  authoredBy: { sessionId: string | null; client: string | null };
  terms: MandateTerms;
  counterOf?: string | null;
}

/**
 * Author a draft. Terms are validated NOW — a request the human could never
 * activate is refused at authoring time with the exact reason, so the
 * negotiation happens over valid shapes only. Terms are deep-copied: the
 * author keeps no live reference into the draft.
 */
export function openDraft(input: DraftInput, now: number, rand?: Uint8Array): MandateDraftV1 {
  const invalid = termsInvalidReason(input.terms);
  if (invalid !== null) throw new MandateRefusedError("terms_invalid", invalid);
  return {
    schema: "governor.mandate-draft/v1",
    id: mintId("mandate", now, rand),
    authoredBy: { sessionId: input.authoredBy.sessionId, client: input.authoredBy.client },
    counterOf: input.counterOf ?? null,
    requestedAt: now,
    terms: cloneTerms(input.terms),
    status: "open",
  };
}

// ── Status transitions — one-way ─────────────────────────────────────────────

export function supersedeDraft(d: MandateDraftV1): MandateDraftV1 {
  if (d.status !== "open") return d;
  return { ...d, status: "superseded" };
}

export function markDraftActivated(d: MandateDraftV1): MandateDraftV1 {
  if (d.status !== "open") {
    throw new MandateRefusedError("draft_not_open", `draft ${d.id} is ${d.status}; only an open draft activates`);
  }
  return { ...d, status: "activated" };
}

export function declineDraft(d: MandateDraftV1, reason: string): MandateDraftV1 {
  if (d.status !== "open") return d;
  return { ...d, status: "declined", declinedReason: reason };
}
