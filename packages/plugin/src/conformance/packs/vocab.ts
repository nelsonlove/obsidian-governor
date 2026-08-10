// packs/vocab.ts — the vocab rule pack: adapts kernel/vocab/findings.ts's
// pure `noteVocabFindings` to the canonical Finding shape.
//
// Mapping (the frozen contract): a VocabFinding {code, token, path, detail}
// becomes { script: "vocab_findings", check: code, target: path, kind: token }.
// The token's CASE IS PRESERVED in the key: two distinct-case tokens on one
// note are distinct findings, so lower-casing them would collapse them to one
// ratchet key and could mask a genuinely-new violation (a ratchet must never
// silently drop a regression — false-NEW churn is safer than false-CARRIED).
// The finding logic is NOT re-implemented here — this only re-homes the output.

import { noteVocabFindings } from "../../kernel/vocab/findings.js";
import type { VocabularyProvider } from "../../kernel/vocab/provider.js";
import type { Finding } from "../finding.js";
import type { RulePack, VaultSnapshot } from "../rule-pack.js";

export const VOCAB_PACK_ID = "vocab_findings";

export function vocabPack(providers: VocabularyProvider[]): RulePack {
  return {
    id: VOCAB_PACK_ID,
    run(snapshot: VaultSnapshot): Finding[] {
      const out: Finding[] = [];
      for (const note of snapshot.notes) {
        for (const f of noteVocabFindings({ path: note.path, frontmatter: note.frontmatter ?? null }, providers)) {
          out.push({
            script: VOCAB_PACK_ID,
            check: f.code,
            target: f.path ?? f.token,
            kind: f.token,
            detail: f.detail,
          });
        }
      }
      return out;
    },
  };
}
