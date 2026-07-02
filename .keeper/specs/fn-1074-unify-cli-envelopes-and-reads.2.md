## Description

**Size:** M
**Files:** cli/show-job.ts, cli/search-history.ts, cli/find-file-history.ts, cli/show-session-events.ts, cli/session-state.ts, cli/control-rpc.ts, cli/autopilot.ts, plugins/plan/src/verbs/ (find-task-commit, epics paging)

### Approach

Move the bare readers onto the shared envelope: today they emit a raw object on success but
{success:false, error:String(e)} on failure (cli/show-job.ts:64-66 vs :463) — the branch key
does not exist on the happy path. Wrap success payloads under data, give failures real
error.{code,message,recovery} (no more String(e)). EXEMPT show-session-files (deliberate
snake_case Python-parity — do not touch). Migrate control-RPC prints: sendControlRpc
(cli/control-rpc.ts:212-233) writes raw JSON.stringify(value) for every autopilot op
(autopilot.ts:1054-1209) — wrap in the envelope, and give server errors a code + recovery
instead of bare stderr. Give `plan epics` the {total, returned, truncated, hint} paging keys
its siblings list/tasks already carry.

### Investigation targets

**Required** (read before coding):
- cli/show-job.ts:64-66,463 — the shape flip to eliminate
- cli/control-rpc.ts:212-233 + cli/autopilot.ts:1054-1209 — every RPC print site
- plugins/plan/src/verbs/{list,tasks,epics}.ts — the paging-key asymmetry

### Risks

- In-repo consumers of the old bare-reader shapes: keeper skills' pre-checks, keeper/api.py, statusline-worker — audit and update in the same change; anything external gets the error.message compatibility noted in the registry doc.

### Test notes

Snapshot success + failure per migrated command; grep skills for the old shapes and update
quoted examples in the same commit.

## Acceptance

- [ ] All seven bare readers emit the envelope on success AND failure; String(e) eliminated
- [ ] Autopilot control ops emit the envelope; server errors carry code + recovery
- [ ] plan epics carries the paging keys; show-session-files untouched

## Done summary

## Evidence
