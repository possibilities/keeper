## Description

**Size:** M
**Files:** cli/status.ts, test/status.test.ts, docs/adr/

### Approach

Extend `tallyVerdicts` in place (never a parallel counter) so the counts split
stale-running from live running, deriving the subtype from the same machinery
the board pill uses — prefer consuming the existing verdict/pill token without
changing the readiness verdict shape; extend that shape minimally only if the
tally input genuinely lacks the subtype. Add the stale counts to the JSON
envelope additively; `running_jobs` keeps emitting with its docstring marking it
deprecated in favor of `board_work_jobs` (zero in-repo consumers beyond one
fixture; external readers stay unbroken). Bump/document the schema doc
accordingly. Human-rendered summaries show stale entries with their last-evidence
freshness, not confident present tense. Ship the decision as a new
provisional-numbered ADR: the deprecation model (emit-both, docstring-deprecated),
the stale-count taxonomy, and why removal is deferred. Re-verify the observed
`running:sub-agent-stale` pill while a nested wrapped Provider leg is positively
live and editing — stale evidence must not present as dead work; record the
verdict in Evidence.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/status.ts:296-317 — tallyVerdicts; :397-403 — runningJobs/boardWorkJobs; :461-462 — envelope emission; :74-119 — schema docstring
- src/board-render.ts:571-628 — bucketForToken stale/live branch ordering (the taxonomy to mirror)
- src/readiness-client.ts:2401-2417 — where the stale reference timestamp is injected

**Optional** (reference as needed):
- src/icon-theme.ts:100-104 — existing stale/live icon split
- cli/status.ts:198,456-457 — legacy wrapped Provider leg counting (for the stale-pill re-verification)

### Risks

- Deriving staleness by re-parsing pill strings would couple counts to display text — use the token/verdict machinery
- fn-1326 lands served boot-identity fields in the same fixture file — the epic dep serializes, but rebase carefully

### Test notes

Extend the status fixture: mixed live/stale running jobs produce split counts;
envelope carries both old and new fields; the deprecated field still emits.
Board test already pins the pill contract — keep them consistent.

## Acceptance

- [ ] Status counts and JSON envelope distinguish stale-running from live running additively, consistent with the board pill taxonomy
- [ ] running_jobs still emits and is documented deprecated in favor of board_work_jobs; a new ADR records the deprecation model and taxonomy decision
- [ ] Stale entries in human output co-display last-evidence freshness
- [ ] The wrapped-Provider-leg stale-pill observation is re-verified with the verdict recorded in Evidence
- [ ] Named test gates for status and board pass

## Done summary
Split stale-running from live-running in status counts and per-row JSON views, added last_evidence_at freshness on stale rows, kept running_jobs emitting with a deprecation docstring, and recorded the decision in ADR 0083.
## Evidence
