// PROPOSAL STORE — durable, append-only, same shape as sessions (WP6).
//
// Events appended, state folded, garbage skipped in the safe direction. One
// deliberate difference from the session store: state transitions are
// validated by the proposal module's own transition functions during the
// fold, so a hand-crafted event claiming an illegal transition (admitted
// without verification, say) is DROPPED by the fold rather than believed —
// the log records what was claimed; the fold answers what holds.

import {
  withAdmitted,
  withRevisionRequested,
  withSuperseded,
  withVerification,
  type ProposalV1,
} from "./proposal.js";
import type { VerificationState } from "../contracts/states.js";

export type ProposalEvent =
  | { kind: "opened"; at: number; proposal: ProposalV1 }
  | { kind: "verification"; at: number; proposalId: string; state: VerificationState }
  | { kind: "admitted"; at: number; proposalId: string; admissionClaimId: string }
  | { kind: "revision-requested"; at: number; proposalId: string }
  | { kind: "superseded"; at: number; proposalId: string };

export interface ProposalEventIo {
  appendLine(line: string): Promise<void>;
  readLines(): Promise<string[]>;
}

export interface ProposalStore {
  open(proposal: ProposalV1, now: number): Promise<void>;
  setVerification(proposalId: string, state: VerificationState, now: number): Promise<void>;
  markAdmitted(proposalId: string, admissionClaimId: string, now: number): Promise<void>;
  requestRevision(proposalId: string, now: number): Promise<void>;
  supersede(proposalId: string, now: number): Promise<void>;
  get(proposalId: string): Promise<ProposalV1 | null>;
  /** All proposals whose authority axis is still `proposed`. */
  pending(): Promise<ProposalV1[]>;
  all(): Promise<ProposalV1[]>;
}

export function foldProposalEvents(lines: readonly string[]): Map<string, ProposalV1> {
  const out = new Map<string, ProposalV1>();
  for (const line of lines) {
    let ev: ProposalEvent;
    try {
      ev = JSON.parse(line) as ProposalEvent;
    } catch {
      continue;
    }
    if (ev.kind === "opened" && ev.proposal?.id) {
      if (!out.has(ev.proposal.id)) out.set(ev.proposal.id, ev.proposal);
      continue;
    }
    const cur = "proposalId" in ev ? out.get(ev.proposalId) : undefined;
    if (!cur) continue;
    try {
      if (ev.kind === "verification") out.set(cur.id, withVerification(cur, ev.state));
      else if (ev.kind === "admitted") out.set(cur.id, withAdmitted(cur, ev.admissionClaimId));
      else if (ev.kind === "revision-requested") out.set(cur.id, withRevisionRequested(cur));
      else if (ev.kind === "superseded") out.set(cur.id, withSuperseded(cur));
    } catch {
      // An event claiming an illegal transition is recorded history the fold
      // refuses to believe — the stronger existing state is kept.
    }
  }
  return out;
}

export function createProposalStore(io: ProposalEventIo): ProposalStore {
  let lines: string[] | null = null;

  async function allLines(): Promise<string[]> {
    if (lines === null) lines = await io.readLines();
    return lines;
  }

  async function state(): Promise<Map<string, ProposalV1>> {
    return foldProposalEvents(await allLines());
  }

  async function append(ev: ProposalEvent): Promise<void> {
    // Cache seeded BEFORE the append — see session-store: a cold cache read
    // after appendLine would double-count the new line.
    const cached = await allLines();
    const line = JSON.stringify(ev);
    await io.appendLine(line);
    cached.push(line);
  }

  async function requireKnown(proposalId: string): Promise<ProposalV1> {
    const cur = (await state()).get(proposalId);
    if (!cur) throw new Error(`proposal ${proposalId} is not in the store`);
    return cur;
  }

  return {
    async open(proposal, now) {
      const m = await state();
      if (m.has(proposal.id)) throw new Error(`proposal ${proposal.id} is already recorded`);
      await append({ kind: "opened", at: now, proposal });
    },
    async setVerification(proposalId, stateValue, now) {
      const cur = await requireKnown(proposalId);
      withVerification(cur, stateValue); // validate BEFORE recording the event
      await append({ kind: "verification", at: now, proposalId, state: stateValue });
    },
    async markAdmitted(proposalId, admissionClaimId, now) {
      const cur = await requireKnown(proposalId);
      withAdmitted(cur, admissionClaimId); // validate BEFORE recording
      await append({ kind: "admitted", at: now, proposalId, admissionClaimId });
    },
    async requestRevision(proposalId, now) {
      const cur = await requireKnown(proposalId);
      withRevisionRequested(cur);
      await append({ kind: "revision-requested", at: now, proposalId });
    },
    async supersede(proposalId, now) {
      const cur = await requireKnown(proposalId);
      withSuperseded(cur);
      await append({ kind: "superseded", at: now, proposalId });
    },
    async get(proposalId) {
      return (await state()).get(proposalId) ?? null;
    },
    async pending() {
      return [...(await state()).values()].filter((p) => p.authority === "proposed");
    },
    async all() {
      return [...(await state()).values()];
    },
  };
}
