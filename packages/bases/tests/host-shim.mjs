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
//      plugin's id is `vault-bases`, so `query` is on the wire as
//      `vault_bases_query`. The sanitizer is the host's `sanitizeOwnerId`,
//      reproduced here as the same two replaces.
//   2. THE ENVELOPE. ok / fail, including `fail`'s coded rendering and its
//      lowercase-snake gate (a Node error's UPPERCASE `.code` renders plain).
//   3. THE ANNOTATIONS the host derives from the SDK's `readOnly` flag —
//      including that an untrusted `readOnly: true` becomes
//      `readOnlyHint: false`, which is the whole reason this package's
//      allowlist posture is what it is. `trusted: true` opts into believing
//      the claim, for the tests that pin the difference.
//
// It deliberately does NOT reproduce the F3 pathless-tool block, the path
// allowlist, the write queue, the journal, or read-only mode: those are host
// code with host tests, and re-implementing them here would be a second copy
// that could drift into asserting a posture the host does not actually enforce.
// What this package DOES pin about them is the only half it owns — WHICH of its
// argument names the host's guard can recognize (see the `publication` tests).

const PLUGIN_ID = "vault-bases";

/** The host's `sanitizeOwnerId`, verbatim. */
export function sanitizeOwnerId(id) {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export const OWNER = sanitizeOwnerId(PLUGIN_ID);

/**
 * The host's PATH_KEYS + ARRAY_PATH_KEYS (packages/plugin/src/guard.ts), copied
 * as DATA so this package can assert which of its own argument names are on the
 * list and which are not.
 *
 * IT IS A REVIEW AID, NEVER A LIVE TRIPWIRE. This copy does not notice when the
 * host changes its list — nothing here reads the host's source — it only makes
 * a host-side change show up as a diff a reviewer has to reconcile. The pin
 * that actually FIRES when the host's list changes is the host's own
 * `tests/guard.test.mjs` over the live `collectPaths`.
 */
export const HOST_PATH_KEYS = [
  "path", "from", "to", "target_path", "template_path", "subdir", "file_path", "output_folder",
  "paths", "refs",
];

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
 * Returns `{ tools }`, a Map from the PUBLISHED name to `{ def, handler }` —
 * the same shape the host's own `fakeServer` produces, so assertions read the
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
