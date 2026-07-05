## Description

**Size:** M
**Files:** cli/escalation-brief.ts, cli/keeper.ts, test/escalation-brief.test.ts

### Approach

A read-only keeper-core CLI verb — `keeper escalation-brief <unblock::fn-N-slug.M | deconflict::fn-N-slug>` — assembles the context envelope an escalation session loads at boot. It lives in keeper core (not the plan plugin) because the payload spans both stores: keeper.db (`jobs.transcript_path`, `jobs.plan_verb`/`plan_ref`, `epics.job_links`, the `dispatch_failures` reason row) and the repo's `.keeper` tree (`created_by_close_of`, blocked task state, ids). The envelope is a single JSON root on stdout: kind, task/epic ids, primary_repo, incident (deconflict: the sticky worktree-merge-conflict reason with source/target branch and stderr plus the `resolve::<epic>` job's terminal verdict; unblock: blocked reason with CATEGORY plus the epic's other currently-blocked sibling tasks), and lineage: the direct creator `{session_id, transcript_path, is_closer}` and — when the creator is a closer — the original creator resolved by walking `created_by_close_of` (equivalently the closer job's `plan_ref`) to the source epic's creator edge. The walk is bounded (~5 hops, cycle-guarded) in case a closer chain nests; the envelope carries the chain with the direct creator and root creator called out. Lineage or transcript misses degrade to a partial envelope with explicit degraded flags (resolver-brief precedent) at exit 0 — never a hard failure that blocks the session; exit non-zero only for an unparseable key or unknown incident.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/bus-identity.ts:257-287 — roleJobIds (creator edge from epics.job_links); src/bus-wake.ts:193-203 — pickCreatorJob newest-by-updated_at pick
- plugins/plan/src/models.ts:46 and plugins/plan/src/verbs/scaffold.ts:1114 — the created_by_close_of field (read the epic JSON file directly and defensively; keeper core must not import the plan plugin)
- src/db.ts:961 — jobs.transcript_path; src/reducer.ts:4382 — plan_verb/plan_ref projection
- cli/session-summary.ts — read-only keeper.db open pattern and cli/keeper.ts registration shape

**Optional** (reference as needed):
- plugins/plan/src/verbs/close_preflight.ts — envelope and degrade conventions (shape only; this verb emits inline on stdout, no brief_ref file)
- plugins/plan/src/verbs/scaffold.ts:88-157 — cross-repo created_by_close_of fail-loud guard (mirror as degrade, not throw)

### Risks

- Reading .keeper epic JSON from keeper core shadows a schema the plan plugin owns — read only the fields needed, tolerate absence.
- A dead/never-recorded creator session yields no jobs row: the envelope must still emit with degraded lineage rather than erroring.

### Test notes

sandboxEnv + freshDbFile with hand-inserted jobs/epics rows and a tmp .keeper tree. Cover: non-closer creator; closer creator resolving to the original creator; missing job_links edge (degraded); missing transcript_path (degraded); unknown key (exit 1). Single-JSON-root output conformance.

## Acceptance

- [ ] keeper escalation-brief accepts both key shapes and emits one JSON root with kind, ids, primary_repo, incident, and lineage
- [ ] A closer creator is flagged is_closer and the original creator is resolved through created_by_close_of/plan_ref, both with session_id and transcript_path
- [ ] Lineage/transcript misses produce degraded partial envelopes at exit 0; only an unparseable key or unknown incident exits non-zero
- [ ] The verb is read-only (no DB or .keeper writes) and registered in the keeper CLI with help text

## Done summary

## Evidence
