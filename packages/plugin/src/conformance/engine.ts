// engine.ts — runs the configured rule packs over a vault snapshot and returns
// the collected findings, sorted by key for a deterministic listing.
//
// A pack that THROWS does not abort the run — its crash surfaces as a
// `conformance_engine / pack_error` finding (target = the pack id) so a broken
// pack is VISIBLE in the report rather than silently reading as "zero
// findings" (the same discipline the Python rail's per-script sentinels
// enforce). Every other pack still runs.

import { findingKey, type Finding } from "./finding.js";
import type { RulePack, VaultSnapshot } from "./rule-pack.js";

export const ENGINE_ID = "conformance_engine";

export function runEngine(packs: RulePack[], snapshot: VaultSnapshot): Finding[] {
  const findings: Finding[] = [];
  for (const pack of packs) {
    try {
      findings.push(...pack.run(snapshot));
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      findings.push({
        script: ENGINE_ID,
        check: "pack_error",
        target: pack.id,
        kind: "",
        detail: `rule pack '${pack.id}' threw: ${detail}`,
      });
    }
  }
  findings.sort((a, b) => {
    const ka = findingKey(a);
    const kb = findingKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return findings;
}
