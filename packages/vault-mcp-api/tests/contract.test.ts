// tests/contract.test.ts — the reason this SDK lives in the monorepo (#86):
// pin the SDK's declared boundary (apiVersion + registration shapes) to what
// the HOST actually accepts, by importing the host's real source
// (packages/plugin/src/mcp/external-tools.ts). If either side drifts, this
// file fails to type-check or these tests fail — the contract cannot drift
// silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { publishTools } from "../src/index.js";
import type {
  VaultMcpApi as SdkVaultMcpApi,
  ExternalToolSpec as SdkExternalToolSpec,
  JsonSchemaObject as SdkJsonSchemaObject,
} from "../src/index.js";
import {
  ExternalToolRegistry,
  sanitizeOwnerId,
  type VaultMcpApi as HostVaultMcpApi,
  type ExternalToolSpec as HostExternalToolSpec,
} from "../../plugin/src/mcp/external-tools.js";
import type { JsonSchemaObject as HostJsonSchemaObject } from "../../plugin/src/mcp/json-schema-to-zod.js";

// ── Type-level contract, checked by `tsc -p tsconfig.tests.json` ─────────────
// (the package's test script runs it).
//
// The api SURFACE must agree in both directions; the SPEC/SCHEMA relation is
// deliberately one-directional. The SDK's JsonSchemaObject keeps `properties`
// as Record<string, unknown> — WIDER than the host's declared
// Record<string, JsonSchemaProperty> subset — because the host's stated
// contract (json-schema-to-zod.ts) is that constructs outside the subset
// degrade to z.unknown() rather than being rejected; the real acceptance gate
// is the host's runtime validation in registerTools, exercised by the runtime
// tests below. So the pinned direction is: everything the HOST declares
// acceptable must be expressible through the SDK's types (Host → SDK). If the
// host ever narrows or reshapes its boundary, these lines stop compiling.

type Assignable<A, B> = [A] extends [B] ? true : false;
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// NOTE: method syntax makes registerTools/unregisterTools parameter-BIVARIANT,
// so _api alone would miss parameter drift — the direct _spec/_schema pins
// below are what carry that load.
const _api: MutuallyAssignable<SdkVaultMcpApi, HostVaultMcpApi> = true;
const _spec: Assignable<HostExternalToolSpec, SdkExternalToolSpec> = true;
const _schema: Assignable<HostJsonSchemaObject, SdkJsonSchemaObject> = true;
// apiVersion is the literal 1 on BOTH sides — a bump on either end must land here.
const _vHostToSdk: SdkVaultMcpApi["apiVersion"] = 1 as HostVaultMcpApi["apiVersion"];
const _vSdkToHost: HostVaultMcpApi["apiVersion"] = 1 as SdkVaultMcpApi["apiVersion"];
void [_api, _spec, _schema, _vHostToSdk, _vSdkToHost];

// ── Runtime contract: the real SDK against the real host registry ────────────
// Mirrors how packages/plugin/src/main.ts exposes the api object
// (apiVersion: 1 wrapping an ExternalToolRegistry instance).

function hostWorld() {
  const registry = new ExternalToolRegistry();
  const api: HostVaultMcpApi = {
    apiVersion: 1,
    registerTools: (owner, tools) => registry.registerTools(owner, tools),
    unregisterTools: (owner) => registry.unregisterTools(owner),
  };
  const app = {
    workspace: {
      on: () => ({}),
      offref: () => {},
      trigger: () => {},
    },
    plugins: { plugins: { "vault-mcp": { api } } },
  };
  const plugin = { app, manifest: { id: "contract-probe" } } as never;
  return { registry, plugin };
}

test("publishTools registers through the real host registry; zod shape survives host validation", async () => {
  const { registry, plugin } = hostWorld();
  publishTools(plugin, [{
    name: "echo",
    description: "contract probe",
    inputSchema: { text: z.string().describe("what to echo") },
    readOnly: true,
    destructive: false,
    handler: async (args) => ({ echoed: args.text }),
  }]);
  const entries = registry.entries();
  assert.equal(entries.length, 1);
  // Published name is `${sanitizeOwnerId(id)}_${name}` — the naming the SDK documents.
  assert.equal(entries[0].toolName, `${sanitizeOwnerId("contract-probe")}_echo`);
  assert.equal(entries[0].ownerId, "contract-probe");
  // The SDK's zod→JSON Schema conversion produced something the host's F8
  // validation accepted (registerTools would have thrown otherwise); check shape.
  const schema = entries[0].spec.inputSchema;
  assert.ok(schema);
  assert.equal(schema.type, "object");
  assert.equal((schema.properties?.text as { type?: string })?.type, "string");
  assert.deepEqual(schema.required, ["text"]);
  // Annotation hints crossed intact.
  assert.deepEqual(entries[0].spec.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
  });
  // The handler crossed as a callable and round-trips plain JSON.
  assert.deepEqual(await entries[0].spec.handler({ text: "hi" }), { echoed: "hi" });
});

test("host rejects a raw zod schema at the boundary — the SDK's conversion is load-bearing", () => {
  const { registry } = hostWorld();
  assert.throws(
    () => registry.registerTools("contract-probe", [{
      name: "bad",
      description: "zod must not cross the plugin boundary",
      inputSchema: z.object({ x: z.string() }) as unknown as HostJsonSchemaObject,
      handler: () => ({}),
    }]),
    /plain JSON Schema/,
  );
});

test("readOnly omitted ⇒ host sees a mutating tool (readOnlyHint false)", () => {
  const { registry, plugin } = hostWorld();
  publishTools(plugin, [{ name: "mutator", description: "d", handler: () => ({}) }]);
  const [entry] = registry.entries();
  assert.equal(entry.spec.annotations?.readOnlyHint, false);
});
