// seal-registration.ts — make "one interception point" true by construction.
//
// `buildMcpServer` monkey-patches `server.registerTool` so every tool passes
// through `makeGuarded` + `withKernelArgs`: guard, allowlist, read-only mode,
// kernel args, queue, journal. `module.ts` states the resulting property as
// "no module-specific bypass possible."
//
// That sentence was stronger than what was enforced (#83's accept-reachability
// review). The SDK's `McpServer` exposes FIVE other registration entry points —
// `tool` (the older tool-registration API), `prompt`, `registerPrompt`,
// `resource`, `registerResource` — and none of them were patched. Anything
// holding a server-shaped object could register a client-reachable surface that
// never passed the guard. `moduleFromRegistrar` hands adapted modules the real
// server (`server: any`, by its own comment), so a module was exactly such a
// holder.
//
// No live bypass existed: our own code, and every module in the tree, registers
// only through `registerTool`. This is a containment fix, not an incident
// response — and the reason to do it BEFORE #83 rather than after is that the
// module #83 mounts is the one holding the accept veto. A future author reading
// "no module-specific bypass possible" would be relying on a guarantee the code
// did not make.
//
// WHY SEAL RATHER THAN ROUTE. `tool()` could in principle be forwarded into the
// guarded path, but its signature differs (overloaded arity, optional schema)
// and silently re-mapping arguments into a security-critical wrapper is how the
// next bypass gets written. `prompt`/`resource` register surfaces this plugin
// has never used at all. Refusing loudly is honest, costs nothing today, and
// leaves routing available later as a deliberate change rather than an
// accident. This is the same fail-closed reasoning the accept guard uses: where
// the safe set is genuinely empty, refusing is free.

/** Registration entry points that must never register anything unguarded. */
export const SEALED_REGISTRARS = [
  "tool",
  "prompt",
  "registerPrompt",
  "resource",
  "registerResource",
] as const;

const SEALED_FLAG = "__vaultMcpRegistrationSealed";

/**
 * Seal every registration entry point except the guarded `registerTool`.
 *
 * Idempotent (a second call is a no-op, so it cannot double-wrap), and it never
 * ADDS a method the server did not already expose — sealing is about closing
 * what exists, not inventing surface. A sealed method throws rather than
 * returning quietly: a silent no-op would leave the caller believing it
 * registered something, which is the absence-read-as-emptiness mistake wearing
 * a different hat.
 */
export function sealUnguardedRegistration(server: unknown): void {
  const s = server as Record<string, unknown>;
  if (!s || typeof s !== "object") return;
  if (s[SEALED_FLAG]) return;

  for (const name of SEALED_REGISTRARS) {
    if (typeof s[name] !== "function") continue; // never invent surface
    s[name] = (..._args: unknown[]): never => {
      throw new Error(
        `vault-mcp: '${name}()' is sealed — it registers a client-reachable surface that would bypass the ` +
          `guard, the path allowlist, read-only mode, the kernel arguments, the write queue and the journal. ` +
          `Register through 'registerTool', which is the one interception point where those are applied. ` +
          `(If a prompt/resource surface is ever genuinely wanted, route it through the guard deliberately ` +
          `rather than by calling this.)`,
      );
    };
  }

  Object.defineProperty(s, SEALED_FLAG, { value: true, enumerable: false });
}
