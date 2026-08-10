export function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

export function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  // Surface a TYPED tool-error's code as `Error [code]: message`, the shape the
  // rest of the surface already uses (guarded.ts codedError, the batch decoder).
  // Gated to lowercase_snake codes — our own convention (accept_forbidden,
  // rev_conflict, …) — so a Node/system error's UPPERCASE `.code` (ENOENT, …)
  // is never mistaken for one and still renders as a plain `Error: message`.
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[a-z][a-z0-9_]*$/.test(code)) {
    return { content: [{ type: "text" as const, text: `Error [${code}]: ${message}` }], isError: true as const };
  }
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true as const };
}
