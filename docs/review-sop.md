# Review SOP — comments are the gate

*The durable record of the fleet's review protocol (#131), companion to the claiming SOP (#123).*

## The constraint

Every fleet session authenticates as one GitHub account. Consequently, on any PR the fleet
authored: `gh pr review --approve` fails ("Can not approve your own pull request"),
`--request-changes` fails the same way, reviewer assignment is inert, and `reviewDecision`
is `null` fleet-wide — on reviewed and unreviewed PRs alike. **The formal review surface
cannot express a review here.** "0 formal reviews" is indistinguishable from "nobody
reviewed this," which has already let unreviewed PRs merge silently.

## The protocol

1. **A review verdict is a PR comment** — posted by the reviewing session, signed with its
   handle, opening with an explicit verdict token: `APPROVE` or `REQUEST CHANGES` (with an
   enumerated defect list). The comment *is* the verdict; there is no formal review to file.
   (Reviews produced by a fresh-context subagent are reported the same way by the session
   that dispatched them, naming the review as independent.)
2. **Before merging, read the comments, not `reviewDecision`.** A PR is reviewed when it
   carries a signed verdict from a session (or fresh-context reviewer) that did not author
   it. `reviewDecision: null` means nothing.
3. **Authorship is by handle, not by account.** The author states their handle in the PR
   body; the reviewer states theirs in the verdict. "Never review your own" is enforced by
   handle.
4. **Two verdicts for Critical, perimeter, and acceptance-path changes**; one otherwise.
5. **A blocking verdict is owned by its author** until that author explicitly clears it.
   Another session's APPROVE does not cancel it.
6. **The merging session states, in the merge (or its report), whose verdict(s) it relied
   on** — converting the convention into a written record.

## Guard (open)

The silent failure mode is a merge with no verdict. A pre-merge check that the PR carries a
non-authoring verdict comment (the docs-drift-ratchet instinct: make the class impossible to
regress) remains a candidate; until then this document plus the protocol above are the gate.
