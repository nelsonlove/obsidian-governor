// UUIDv7 — promoted into @vault-mcp/core (S3, condition 9): the governance
// provider imported this module from the host at two call sites
// (governor/kernel/contracts/ids.ts, governor/kernel/gesture.ts), so the
// implementation now lives in the shared contract package. This file is a
// thin re-export kept ONLY so main.ts's existing `./kernel/uuidv7.js` import
// keeps resolving (main.ts is the composition root other S3 work streams
// touch and is out of scope for this change) — every other importer in the
// plugin has been repointed to `@vault-mcp/core` directly.
export { uuidv7 } from "@vault-mcp/core";
