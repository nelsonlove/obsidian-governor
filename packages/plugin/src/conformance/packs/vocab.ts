// packs/vocab.ts — the vocab rule pack: adapts kernel/vocab/findings.ts's
// pure `noteVocabFindings` to the canonical Finding shape.
//
// Mapping (the frozen contract): a VocabFinding {code, token, path, detail}
// becomes { script: "vocab_findings", check: code, target: path, kind:
// token(lower-cased) }. The token is lower-cased to match the ratchet's
// existing token-normalization convention (ste_lint keys lower-cased tokens),
// so case variants of the same offending token share a key. The finding logic
// is NOT re-implemented here — this only re-homes the module's output.

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
            kind: f.token.toLowerCase(),
            detail: f.detail,
          });
        }
      }
      return out;
    },
  };
}
