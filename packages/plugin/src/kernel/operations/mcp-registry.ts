// The PER-CONNECTION action registry for the MCP surface — Gate 0, WP1.
//
// `buildMcpServer` constructs a fresh `McpServer` for every connection, because
// conditional registration at build time IS this plugin's dynamic-registration
// mechanism. The action registry has to follow the same lifetime, for a reason
// that only becomes visible here:
//
//   a third-party publisher's tool names are `${sanitizedOwnerId}_${name}`,
//   computed from whatever plugins are loaded at the moment the connection is
//   built. They cannot be declared in a static inventory, and they cannot be
//   scanned out of this repository's source, because they are not in it.
//
// A weaker check — "accept any surface id for the external-publisher action" —
// would have made the executor's guarantee conditional exactly where the threat
// model is least comfortable: third-party code, whose read-only claims are
// already disbelieved by default. Instead the publisher's snapshot is turned
// into real bindings at the moment its names are known, so the executor's
// lookup stays exact for every surface, in-repo or not.
//
// Obsidian-free, like the rest of `kernel/`: it takes the external tool names
// as data.

import { compatibilityAction, compatibilityActionId } from "./compatibility.js";
import { mcpCompatibilityActions, mcpSurfaceBindings } from "./inventory-mcp.js";
import { createActionRegistry, type ActionRegistry } from "./registry.js";

export interface ExternalToolSnapshot {
  /** The published name, already namespaced by the publisher's sanitized id. */
  name: string;
  /** The publisher's raw plugin id. */
  owner: string;
  /**
   * Whether the host decided to BELIEVE this tool's read-only claim — that is,
   * the claim was made AND the publisher is explicitly trusted. Never the
   * publisher's assertion on its own.
   */
  readOnly: boolean;
}

/**
 * Build the registry a single connection executes against.
 *
 * Validation is deliberately NOT run here. `validate()` seals the registry, and
 * a sealed registry cannot accept a late binding — but more importantly, a
 * validation problem at connection time is not a reason to refuse the
 * connection: the declared inventory's correctness is a BUILD property, proven
 * by `operations-surface-inventory.test.mjs`. Re-deciding it per connection
 * would turn a build failure into a runtime outage.
 *
 * Problems are returned so the caller can report them the way the module host
 * already reports its own: loudly, to the console, without costing the
 * connection.
 */
export function buildMcpActionRegistry(external: ExternalToolSnapshot[] = []): {
  registry: ActionRegistry;
  problems: string[];
} {
  const registry = createActionRegistry();
  const problems: string[] = [];

  for (const action of mcpCompatibilityActions()) registry.register(action);
  for (const binding of mcpSurfaceBindings()) registry.bind(binding);

  for (const tool of external) {
    // Distribution `private`: a third-party capability is never part of the
    // Community profile by default, whatever its publisher says. The host's
    // own trust decision is already reflected in `readOnly` — the executor
    // records the outcome of that decision rather than re-making it.
    registry.register(
      compatibilityAction({
        surface: tool.name,
        postcondition: `Third-party capability published by '${tool.owner}'. Governor cannot state its postcondition.`,
        owner: `external:${tool.owner}`,
        distribution: "private",
        readOnly: tool.readOnly,
        // Its blast radius is not knowable from here — it is another plugin's
        // handler. `unbounded` is the only honest value, and it is what the
        // adapter defaults a mutating surface to anyway.
        discovered: "unbounded",
        reason: `published at connection time by plugin '${tool.owner}'; names are computed per connection and cannot appear in a static inventory`,
      })
    );
    registry.bind({
      kind: "external",
      id: tool.name,
      action: compatibilityActionId(tool.name),
      actionVersion: 1,
      note: `published by '${tool.owner}'`,
    });
  }

  // Surface-id collisions between a publisher and a built-in are already
  // refused upstream (the reserved `obsidian_` prefix), but the registry
  // records them if one ever slips through, and a silent overwrite here would
  // be the worst possible outcome: a third-party handler inheriting a built-in
  // action's contract.
  for (const problem of registry.validate()) {
    problems.push(`${problem.code}: ${problem.message}`);
  }

  return { registry, problems };
}
