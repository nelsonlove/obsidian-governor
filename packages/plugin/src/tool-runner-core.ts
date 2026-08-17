// tool-runner-core.ts — the pure, headless-testable half of the in-Obsidian dev
// tool-runner ("Vault MCP: Run tool…"). Everything here is DOM-free and
// obsidian-free: tool listing over a captured registry, zod-schema → form-field
// derivation, form-value parsing/assembly, and the run/confirm decision rules.
// The modals themselves (src/tool-runner.ts) are the un-headless remainder.
//
// The runner is NOT a second tool surface. It lists and invokes tools through
// the SAME captured registry a code-mode MCP connection uses (buildMcpServer
// with codeMode: true captures every guarded registration), and it invokes them
// through callCapturedTool — the exact function obsidian_call_tool delegates to
// — so the guard wrapper (read-only mode, path allowlist, uid/scheme
// addressing, accept-forbidden in the write primitives, kernel queue/journal)
// binds identically. No raw handler is ever reachable from here.

import { z, type ZodRawShape } from "zod";
import {
  searchRegistry,
  callCapturedTool,
  type CapturedRegistry,
} from "./mcp/tools-code-mode.js";
import { KERNEL_ARG_KEYS } from "./mcp/guarded.js";

/** One row in the runner's tool picker — same summary shape the code-mode
 * search meta-tool reports (name, title, one-line description, mutating). */
export interface RunnerToolSummary {
  name: string;
  title: string;
  description: string;
  mutating: boolean;
}

/** Every tool on the current captured surface, sorted by name — literally the
 * code-mode `obsidian_search_tools` listing with no query, so the picker and a
 * fresh MCP connection can never disagree about what exists. */
export function listRunnerTools(registry: CapturedRegistry): RunnerToolSummary[] {
  return searchRegistry(registry);
}

/** How a field renders and parses. Everything not a plain string / number /
 * boolean / enum falls back to a JSON textarea — deliberately coarse: four
 * input kinds cover the whole surface without re-implementing zod. */
export type RunnerFieldKind = "string" | "number" | "boolean" | "json";

export interface RunnerField {
  name: string;
  kind: RunnerFieldKind;
  optional: boolean;
  description?: string;
}

/** Innermost schema + the outermost non-empty description on the way down.
 * `.describe()` annotates the wrapper it is called on, and tools write both
 * `z.string().describe(..).optional()` and `z.optional(z.string().describe(..))`
 * — walking wrappers (optional / default / nullable / effects) catches both. */
function unwrapSchema(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; description?: string } {
  let current: z.ZodTypeAny = schema;
  let description: string | undefined;
  for (let i = 0; i < 10; i++) {
    if (description === undefined && current.description) description = current.description;
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap();
    } else if (current instanceof z.ZodDefault) {
      current = current._def.innerType;
    } else if (current instanceof z.ZodEffects) {
      current = current._def.schema;
    } else {
      break;
    }
  }
  return { inner: current, ...(description !== undefined ? { description } : {}) };
}

/**
 * Derive the args-form fields from a captured tool's zod shape. The kernel
 * arguments (`if_rev` / `idempotency_key` / `intent`) are EXCLUDED: they are
 * declared on every mutating tool's schema by withKernelArgs for agents, and
 * the guard wrapper peels them before any handler — a human clicking a form
 * has no use for them, and rendering them would only invite confusion.
 */
export function formFieldsOf(inputSchema: ZodRawShape | undefined): RunnerField[] {
  const fields: RunnerField[] = [];
  for (const [name, schema] of Object.entries(inputSchema ?? {})) {
    if ((KERNEL_ARG_KEYS as readonly string[]).includes(name)) continue;
    const optional = schema.isOptional();
    const { inner, description } = unwrapSchema(schema);
    let kind: RunnerFieldKind;
    let desc = description;
    if (inner instanceof z.ZodString) kind = "string";
    else if (inner instanceof z.ZodNumber) kind = "number";
    else if (inner instanceof z.ZodBoolean) kind = "boolean";
    else if (inner instanceof z.ZodEnum) {
      kind = "string";
      const options = `one of: ${(inner.options as string[]).join(", ")}`;
      desc = desc ? `${desc} (${options})` : options;
    } else kind = "json"; // objects, arrays, unions, records, … — raw JSON
    fields.push({ name, kind, optional, ...(desc !== undefined ? { description: desc } : {}) });
  }
  return fields;
}

/** One field's raw form input → its arg value.
 * Blank means "omit" for an optional field and "missing" for a required one
 * (a deliberately simple dev-tool convention — an optional string cannot be
 * sent as the empty string from this form). Booleans arrive as the strings
 * "true"/"false" (checkbox / dropdown), numbers and JSON are parsed, and a
 * parse failure is reported per field, never thrown. */
export function parseFieldInput(
  field: RunnerField,
  raw: string
): { value: unknown } | { omit: true } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return field.optional ? { omit: true } : { error: `${field.name}: required` };
  }
  switch (field.kind) {
    case "string":
      return { value: raw };
    case "number": {
      const n = Number(trimmed);
      return Number.isFinite(n) ? { value: n } : { error: `${field.name}: "${trimmed}" is not a number` };
    }
    case "boolean": {
      if (trimmed === "true") return { value: true };
      if (trimmed === "false") return { value: false };
      return { error: `${field.name}: expected true or false` };
    }
    case "json": {
      try {
        return { value: JSON.parse(trimmed) };
      } catch (e) {
        return { error: `${field.name}: invalid JSON — ${(e as Error).message}` };
      }
    }
  }
}

/** Assemble the args object from the form's raw values, or report every field
 * error at once (so the human fixes the form in one pass, not one error per
 * click). The result is exactly what callCapturedTool validates against the
 * tool's own zod shape — this layer only converts text to values. */
export function buildRunArgs(
  fields: RunnerField[],
  values: Record<string, string>
): { args: Record<string, unknown> } | { errors: string[] } {
  const args: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const field of fields) {
    const parsed = parseFieldInput(field, values[field.name] ?? "");
    if ("error" in parsed) errors.push(parsed.error);
    else if ("value" in parsed) args[field.name] = parsed.value;
    // omit: leave the key absent, like an MCP caller not sending it.
  }
  return errors.length > 0 ? { errors } : { args };
}

/** A mutating tool always gets the extra "this tool writes — run it?" confirm
 * step, args or not. Same discriminant as the guard: readOnlyHint === false,
 * surfaced here as the summary's `mutating`. */
export function needsConfirm(summary: Pick<RunnerToolSummary, "mutating">): boolean {
  return summary.mutating;
}

/** Run straight from the picker only when there is nothing to ask: no args to
 * collect AND no write to confirm. A zero-arg MUTATING tool still opens the
 * modal for its confirm step. */
export function runsImmediately(fields: RunnerField[], summary: Pick<RunnerToolSummary, "mutating">): boolean {
  return fields.length === 0 && !needsConfirm(summary);
}

/** The result-modal payload: the SDK envelope as the guarded handler returned
 * it (typed errors like `Error [accept_forbidden]: …` arrive as
 * `isError: true` envelopes), plus the wall-clock elapsed time. A THROWN
 * failure (kernel-less edge cases, unexpected bugs) is folded into the same
 * envelope shape so the result modal has one rendering path. */
export interface RunnerRun {
  tool: string;
  args: Record<string, unknown>;
  elapsedMs: number;
  result: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
}

/** Invoke through the captured (guarded) handler — the identical path an MCP
 * code-mode `obsidian_call_tool` call takes — and time it. */
export async function runCapturedTool(
  registry: CapturedRegistry,
  tool: string,
  args: Record<string, unknown>,
  now: () => number = Date.now
): Promise<RunnerRun> {
  const started = now();
  let result: RunnerRun["result"];
  try {
    result = await callCapturedTool(registry, tool, args, {});
  } catch (e) {
    result = { content: [{ type: "text", text: `Error: ${(e as Error)?.message ?? String(e)}` }], isError: true };
  }
  return { tool, args, elapsedMs: now() - started, result };
}

/** The text a run's result modal shows (and its Copy button copies): the
 * structured result pretty-printed when there is one, else the joined text
 * content blocks (which is where typed refusals like `Error [read_only]: …`
 * live). Pure so the rendering choice is testable. */
export function renderResultText(result: RunnerRun["result"]): string {
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent, null, 2);
  const texts = (result.content ?? []).map((c) => c.text ?? "").filter(Boolean);
  return texts.length > 0 ? texts.join("\n") : "(no content)";
}

/** The error line shown prominently at the top of an error result: the first
 * text content block, where every typed code (`[accept_forbidden]`,
 * `[cli_denied]`, `[read_only]`, …) is rendered by the guard and helpers. */
export function errorLineOf(result: RunnerRun["result"]): string | null {
  if (result.isError !== true) return null;
  return result.content?.find((c) => typeof c.text === "string" && c.text)?.text ?? "Error (no message)";
}
