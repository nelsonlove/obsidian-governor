// tests/publish-tools.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { publishTools } from "../src/index.js";

// Minimal fake of the Obsidian surface publishTools touches: workspace event
// bus (on/offref/trigger) + plugins map + plugin.manifest.id.
function fakeWorld(vaultMcpApi: unknown) {
  const handlers = new Map<object, { name: string; cb: (...a: unknown[]) => void }>();
  const app = {
    workspace: {
      on: (name: string, cb: (...a: unknown[]) => void) => { const ref = {}; handlers.set(ref, { name, cb }); return ref; },
      offref: (ref: object) => { handlers.delete(ref); },
      trigger: (name: string, ...a: unknown[]) => { for (const h of handlers.values()) if (h.name === name) h.cb(...a); },
    },
    plugins: { plugins: vaultMcpApi ? { "vault-mcp": { api: vaultMcpApi } } : {} },
  };
  return { app, handlers };
}

function fakeApi(apiVersion = 1) {
  const calls: Array<{ owner: string; tools: Array<Record<string, unknown>> }> = [];
  let unregistered = 0;
  return {
    calls, unregisteredCount: () => unregistered,
    apiVersion,
    registerTools: (owner: string, tools: Array<Record<string, unknown>>) => { calls.push({ owner, tools }); return () => { unregistered += 1; }; },
    unregisterTools: () => {},
  };
}

const plugin = (app: unknown) => ({ app, manifest: { id: "jd-survey" } }) as never;

test("registers immediately when vault-mcp is already loaded; zod shape crosses as JSON Schema", () => {
  const api = fakeApi();
  const { app } = fakeWorld(api);
  publishTools(plugin(app), [{
    name: "survey_slot", description: "d",
    inputSchema: { path: z.string().describe("the path") },
    handler: async () => ({}),
  }]);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].owner, "jd-survey");
  const sent = api.calls[0].tools[0] as { inputSchema: { type: string; properties: { path: { type: string; description: string } }; required: string[] }; annotations: { readOnlyHint: boolean } };
  assert.equal(sent.inputSchema.type, "object");                       // JSON Schema, not zod
  assert.equal(sent.inputSchema.properties.path.type, "string");
  assert.equal(sent.inputSchema.properties.path.description, "the path");
  assert.deepEqual(sent.inputSchema.required, ["path"]);
  assert.equal(sent.annotations.readOnlyHint, false);                  // readOnly omitted ⇒ mutating
});

test("plain JSON Schema input passes through untouched; readOnly maps to readOnlyHint", () => {
  const api = fakeApi();
  const { app } = fakeWorld(api);
  const js = { type: "object" as const, properties: { n: { type: "integer" as const } }, required: ["n"] };
  publishTools(plugin(app), [{ name: "t", description: "d", inputSchema: js, readOnly: true, handler: () => ({}) }]);
  const sent = api.calls[0].tools[0] as { inputSchema: unknown; annotations: { readOnlyHint: boolean } };
  assert.deepEqual(sent.inputSchema, js);
  assert.equal(sent.annotations.readOnlyHint, true);
});

test("property-less JSON Schema passes through, does not hit the zod path", () => {
  const api = fakeApi();
  const { app } = fakeWorld(api);
  const js = { type: "object" as const };
  publishTools(plugin(app), [{ name: "t", description: "d", inputSchema: js, handler: () => ({}) }]);
  const sent = api.calls[0].tools[0] as { inputSchema: unknown };
  assert.deepEqual(sent.inputSchema, js);
});

test("waits for vault-mcp:ready when not loaded; re-registers on reload", () => {
  const api = fakeApi();
  const { app } = fakeWorld(null); // vault-mcp not loaded yet
  publishTools(plugin(app), [{ name: "t", description: "d", handler: () => ({}) }]);
  assert.equal(api.calls.length, 0);
  (app.plugins.plugins as Record<string, unknown>)["vault-mcp"] = { api };
  app.workspace.trigger("vault-mcp:ready", api);
  assert.equal(api.calls.length, 1);
  app.workspace.trigger("vault-mcp:ready", api); // vault-mcp reloaded
  assert.equal(api.calls.length, 2);
  assert.equal(api.unregisteredCount(), 0); // stale unregister dropped, never called
});

test("apiVersion mismatch: warns, never registers", () => {
  const api = fakeApi(2);
  const { app } = fakeWorld(api);
  publishTools(plugin(app), [{ name: "t", description: "d", handler: () => ({}) }]);
  assert.equal(api.calls.length, 0);
});

test("disposer unregisters and unsubscribes", () => {
  const api = fakeApi();
  const { app, handlers } = fakeWorld(api);
  const dispose = publishTools(plugin(app), [{ name: "t", description: "d", handler: () => ({}) }]);
  assert.equal(handlers.size, 1);
  dispose();
  assert.equal(api.unregisteredCount(), 1);
  assert.equal(handlers.size, 0);
  app.workspace.trigger("vault-mcp:ready", api); // must be inert after dispose
  assert.equal(api.calls.length, 1);
});

test("destructive and idempotent flags pass through as annotation hints", () => {
  const api = fakeApi();
  const { app } = fakeWorld(api);
  publishTools(plugin(app), [{ name: "t", description: "d", destructive: true, idempotent: true, handler: () => ({}) }]);
  const sent = api.calls[0].tools[0] as { annotations: Record<string, boolean> };
  assert.deepEqual(sent.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true });
});
