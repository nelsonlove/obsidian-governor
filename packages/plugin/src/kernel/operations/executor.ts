// The SHARED OPERATION EXECUTOR — Gate 0, WP1 (D15, D18).
//
// Every invocation resolves here: MCP tool, Obsidian command, pane gesture,
// automation, internal call, third-party publisher. One boundary, so action
// identity, actor binding, scope derivation, availability, errors and receipt
// semantics are the same wherever a call came in.
//
// WHAT THIS IS NOT, and the restraint is the point:
//
// It is not a second mutation kernel. `Kernel.runMutation` already owns the
// write queue, revision preconditions, idempotency, record immutability,
// advisory-lock disclosure and the write journal, and all of that works. This
// wraps it. Rewriting a working kernel alongside a new architecture is how a
// shipped product breaks; D18 settles the alternative — establish the seam
// first, migrate behind it in risk order.
//
// So WP1 adds exactly three things a caller can observe:
//
//   1. an invocation whose action is not registered is REFUSED, at runtime.
//      The build-time inventory proves what the SOURCE declares; this proves
//      what actually executes. The difference matters for surfaces whose names
//      are computed at runtime — a third-party publisher is precisely the case
//      a source scan cannot see.
//   2. every invocation gets a Governor-derived operation id, actor binding and
//      phase history, whether or not anything durable is written.
//   3. the authority fence is enforced a second time, at invocation. Defence in
//      depth, not redundancy: the build check runs over the declared inventory,
//      this runs over what a caller actually presents.
//
// It claims nothing else. Observations, effects, verification and authority
// links stay EMPTY until WP2 and WP6 build the substrate behind them, because a
// proposal citing an observation that was never captured is worse than one
// citing nothing.

import type { ActionDefinition, SurfaceKind } from "./action.js";
import { isAgentReachable } from "./surface-binding.js";
import type { ActionRegistry } from "./registry.js";
import {
  OPERATION_PHASES,
  nonAuthoritativeDigest,
  normalizeInputs,
  type OperationOutcome,
  type OperationPhase,
  type OperationV1,
  type OperationActor,
} from "./operation.js";

export { OPERATION_PHASES, OPERATION_OUTCOMES } from "./operation.js";
export type { OperationV1, OperationPhase, OperationOutcome } from "./operation.js";

/** Base for every refusal the executor makes before a handler runs. */
export class OperationRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The caller named an action, or an action version, that is not registered. */
export class UnregisteredActionError extends OperationRefusedError {
  constructor(action: string, version: number) {
    super(
      "unregistered_action",
      `no registered action '${action}@${version}'. Every invocation resolves to a registered action; ` +
        `register it and bind its surface before it can execute.`
    );
  }
}

/** The surface is not bound, or is bound to a different action. */
export class UnboundSurfaceError extends OperationRefusedError {
  constructor(surfaceId: string, action: string) {
    super(
      "unbound_surface",
      `surface '${surfaceId}' is not bound to action '${action}'. A surface opens onto exactly one action, and a ` +
        `caller cannot borrow another surface's contract.`
    );
  }
}

/** A Governor-only action was invoked through an agent-reachable surface. */
export class AuthoritySurfaceError extends OperationRefusedError {
  constructor(surfaceId: string, kind: SurfaceKind, action: string) {
    super(
      "authority_surface",
      `action '${action}' is Governor-only and cannot be invoked through the agent-reachable surface ` +
        `'${surfaceId}' (${kind}). Governor alone admits or advances standing.`
    );
  }
}

export interface OperationRequest {
  action: string;
  actionVersion: number;
  surface: { kind: SurfaceKind; id: string };
  inputs: unknown;
  /** Present once sessions exist (WP5); null until then. */
  sessionId?: string | null;
  mandateId?: string | null;
  /** Digest of the effective scope, supplied by the surface that computed it. */
  effectiveScopeDigest?: string;
}

export interface OperationExecutorOpts {
  registry: ActionRegistry;
  /** Governor-derived actor binding. Resolved PER CALL: a client's identity
   * only exists after its handshake, well after the executor is built. */
  actor: () => OperationActor;
  now?: () => number;
  newId?: () => string;
  /**
   * Receives every CLOSED operation, successful or not. A throw here is
   * swallowed — the same rule the write journal already follows: losing
   * observability degrades observability, it never reverses a completed vault
   * operation or costs a caller their result.
   */
  onClose?: (operation: OperationV1) => void;
}

export interface OperationExecutor {
  run<T>(request: OperationRequest, handler: () => Promise<T>): Promise<{ result: T; operation: OperationV1 }>;
}

let seq = 0;
const EPOCH = Date.now().toString(36);

/**
 * Which phases an action's MODE actually activates.
 *
 * A read closes after producing its result; it never queues and never attempts
 * an effect. Recording only what happened is what keeps a receipt honest — and
 * it is checked by a test, because "the envelope has all the fields" is exactly
 * the kind of completeness that reads as evidence without being any.
 */
function phasesFor(action: ActionDefinition): OperationPhase[] {
  const mutates = action.modes.some((m) => m === "proposal-mutation" || m === "mandated-mutation");
  const authority = action.modes.includes("authority");
  const phases: OperationPhase[] = ["received", "resolved"];
  if (mutates) phases.push("queued", "attempted");
  if (authority) phases.push("authorized");
  phases.push("receipt-produced", "closed");
  // Canonical order regardless of the order pushed above.
  return OPERATION_PHASES.filter((p) => phases.includes(p));
}

/**
 * Read the outcome off a result.
 *
 * Tool handlers report failure by RETURNING `{isError: true}` rather than
 * throwing — the `ok()`/`fail()` convention this repo has used since the
 * beginning. An executor that watched only for exceptions would therefore
 * record every refusal as a success, which is the single most misleading thing
 * an operation record could say.
 */
function outcomeOf(result: unknown): OperationOutcome {
  if (result === null || typeof result !== "object") return "completed";
  return (result as { isError?: unknown }).isError === true ? "refused" : "completed";
}

export function createOperationExecutor(opts: OperationExecutorOpts): OperationExecutor {
  const now = opts.now ?? (() => Date.now());
  const newId = opts.newId ?? (() => `${EPOCH}-${++seq}`);

  function close(operation: OperationV1, outcome: OperationOutcome, phases: OperationPhase[]): OperationV1 {
    for (const phase of phases.slice(operation.phases.length)) {
      operation.phases.push({ phase, at: now() });
      operation.phase = phase;
    }
    operation.outcome = outcome;
    try {
      opts.onClose?.(operation);
    } catch (e) {
      console.error("[governor] operation sink failed", e);
    }
    return operation;
  }

  return {
    async run(request, handler) {
      const action = opts.registry.get(request.action, request.actionVersion);
      if (!action) throw new UnregisteredActionError(request.action, request.actionVersion);

      const binding = opts.registry.bindings().find((b) => b.id === request.surface.id);
      if (!binding || binding.action !== action.id || binding.actionVersion !== action.version) {
        throw new UnboundSurfaceError(request.surface.id, `${request.action}@${request.actionVersion}`);
      }

      // The runtime half of the acceptance fence. Checked against the surface
      // the CALLER presented, not the one the inventory declared — the two can
      // differ for a runtime-named surface, and that gap is the whole reason
      // this check exists in addition to the build-time one.
      if (action.authority.governorOnly && isAgentReachable(request.surface.kind)) {
        throw new AuthoritySurfaceError(request.surface.id, request.surface.kind, action.id);
      }

      const phases = phasesFor(action);
      const operation: OperationV1 = {
        schema: "governor.operation/v1",
        id: newId(),
        action: { id: action.id, version: action.version },
        surface: { ...request.surface },
        // Derived, never taken from inputs. A caller that sends `actor` or
        // `signer` is ignored here and refused at the registry.
        actor: opts.actor(),
        sessionId: request.sessionId ?? null,
        mandateId: request.mandateId ?? null,
        normalizedInputDigest: nonAuthoritativeDigest(normalizeInputs(request.inputs)),
        effectiveScopeDigest: request.effectiveScopeDigest ?? nonAuthoritativeDigest(""),
        phase: "received",
        phases: [{ phase: "received", at: now() }],
        // Everything below stays empty in WP1. WP2 fills observations and
        // effects; WP6 fills verification, authority and the proposal subject.
        // Empty is the honest value — a plausible-looking one would be a claim.
        observations: [],
        plan: null,
        attemptedEffects: [],
        observedEffects: [],
        verification: [],
        authority: null,
        proposalSubject: null,
        standingTransition: null,
        outcome: null,
        recovery: null,
      };
      operation.phases.push({ phase: "resolved", at: now() });
      operation.phase = "resolved";

      try {
        const result = await handler();
        close(operation, outcomeOf(result), phases);
        return { result, operation };
      } catch (e) {
        // A failed operation still closes. Evidence that only exists when work
        // succeeds is not evidence.
        close(operation, "failed", phases);
        throw e;
      }
    },
  };
}
