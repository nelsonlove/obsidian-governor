// host-shim.mjs — a stand-in for the Governor host's external-tool registration,
// so the handler-level tests exercise the ENVELOPES an agent actually sees.
// (Not a *.test.mjs file — the test glob skips it.)
//
// A published tool's handler returns plain data or throws; the host turns the
// first into `ok(data)` and the second into `fail(err)`, and `fail` renders a
// lowercase-snake `code` off the error as `Error [code]: message`. That is the
// contract this package's tools are written against, so testing the raw
// handlers alone would leave the refusal shape — the thing the module's
// `codedError` used to guarantee — unpinned.
//
// This shim reproduces exactly three host behaviours and nothing else:
//
//   1. THE PUBLISHED NAME. `<sanitized plugin id>_<bare name>`, and this
//      plugin's id is `vault-vocab`, so `resolve_term` is on the wire as
//      `vault_vocab_resolve_term`. The sanitizer is the host's
//      `sanitizeOwnerId`, reproduced here as the same two replaces.
//   2. THE ENVELOPE. ok / fail, including `fail`'s coded rendering and its
//      lowercase-snake gate (a Node error's UPPERCASE `.code` renders plain).
//   3. THE ANNOTATIONS the host derives from the SDK's `readOnly` flag —
//      including that an untrusted `readOnly: true` becomes
//      `readOnlyHint: false`, which is why all four of this package's tools
//      register as MUTATING by default. `trusted: true` opts into believing the
//      claim, for the tests that pin the difference.
//
// It deliberately does NOT reproduce the F3 pathless-tool block, the path
// allowlist, the write queue, the journal, read-only mode, or the record-
// immutability guard. Those are host code with host tests, and a second copy
// could drift into asserting a posture the host does not actually enforce.
// What this package DOES pin about them is the only half it owns — WHICH of its
// own argument names the host's guard would recognize as a path, which is what
// makes this surface's allowlist posture non-uniform (see the `publication`
// tests).

const PLUGIN_ID = "vault-vocab";

/** The host's `sanitizeOwnerId`, verbatim. */
export function sanitizeOwnerId(id) {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export const OWNER = sanitizeOwnerId(PLUGIN_ID);

/**
 * The host's PATH_KEYS + ARRAY_PATH_KEYS (src/guard.ts), copied as DATA so this
 * package can assert which of its own argument names the host would recognize.
 * The host owns the enforcement; this is only the list the assertion reads
 * against, and it is spelled out here so a host change to the list would show
 * up as a diff in review rather than silently changing this package's posture.
 * It is a REVIEW AID, not a live tripwire: the test that actually fires when
 * the host edits the list is the host's own `tests/guard.test.mjs` pin over the
 * live `collectPaths`.
 */
export const HOST_PATH_KEYS = [
  "path", "from", "to", "target_path", "template_path", "subdir", "file_path", "output_folder",
  "paths", "refs",
];

/**
 * The host's F3 predicate, as a PREDICATE over one call's actual arguments.
 *
 * This is the thing that makes this package different from every prior
 * satellite: F3 is evaluated at CALL TIME on the ARGUMENTS, not once on the
 * declared schema, so a tool whose path argument is OPTIONAL is blocked or
 * scoped depending on how it was called. Reproduced here only far enough to
 * pin that asymmetry — it does not decide anything, it just answers "would the
 * host's `collectPaths(args)` come back empty".
 */
export function carriesPathKey(args) {
  return Object.entries(args ?? {}).some(
    ([k, v]) => HOST_PATH_KEYS.includes(k) && v !== undefined && v !== null && v !== "",
  );
}

/** The host's `ok()` (from @vault-mcp/core). */
function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

/** The host's `fail()` (from @vault-mcp/core), including the coded branch. */
function fail(err) {
  const message = err instanceof Error ? err.message : String(err);
  const code = err?.code;
  if (typeof code === "string" && /^[a-z][a-z0-9_]*$/.test(code)) {
    return { content: [{ type: "text", text: `Error [${code}]: ${message}` }], isError: true };
  }
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/**
 * Wrap SDK tool specs the way the host does.
 *
 * Returns `{ tools }`, a Map from the PUBLISHED name to `{ def, spec, handler }`
 * — the same shape the host's own `fakeServer` produces, so assertions read the
 * same on both sides of the split.
 */
export function publishInto(specs, { trusted = false } = {}) {
  const tools = new Map();
  for (const spec of specs) {
    const claimsReadOnly = spec.readOnly === true;
    const isReadOnly = claimsReadOnly && trusted;
    const def = {
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: {
        readOnlyHint: isReadOnly,
        destructiveHint: spec.destructive ?? !isReadOnly,
        idempotentHint: spec.idempotent ?? isReadOnly,
        openWorldHint: false,
      },
      claimsReadOnly,
    };
    tools.set(`${OWNER}_${spec.name}`, {
      def,
      spec,
      handler: async (args) => {
        try {
          const r = await spec.handler(args ?? {});
          const data =
            r === undefined ? { ok: true } : typeof r === "object" && r !== null && !Array.isArray(r) ? r : { result: r };
          return ok(data);
        } catch (e) {
          return fail(e);
        }
      },
    });
  }
  return { tools };
}
