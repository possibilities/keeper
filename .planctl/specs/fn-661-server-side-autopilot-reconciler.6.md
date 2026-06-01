## Description

**Size:** S
**Files:** CLAUDE.md, README.md

### Approach

Update the prose to the final state. CLAUDE.md: add `DispatchFailed` /
`DispatchCleared` to the synthetic-event enumeration and `dispatch_failures` to
the BEGIN IMMEDIATE projection list in `## Event-sourcing invariants`; extend the
"hook is the sole writer / server-worker write-surface" paragraph and the
`## DO NOT` RPC-scoped-surface paragraph (currently naming set_task_approval /
set_epic_approval / replay_dead_letter) with `set_autopilot_paused` +
`retry_dispatch` and the rationale (autopilot pause is human-intent state with no
hook attachment point; retry clears a failure); add the v42 schema-history line;
correct the worker-count prose. README.md: Install config keys
(`autoclose_windows` / `zellij_session` are now server-side reconciler config),
rewrite the `autopilot.ts` Example-clients entry to the thin viewer, and update
`## Architecture` (worker-fleet count, add the reconciler worker + DispatchFailed
to the synthetic-event enumeration, fix the "readiness stays client-side" note).
Edit CLAUDE.md in place — never rm+recreate the AGENTS.md symlink.

### Investigation targets

**Required** (read before coding):
- CLAUDE.md `## Event-sourcing invariants`, `## DO NOT` (RPC-scoped-surface paragraph), `## Worker contract` (worker count)
- README.md Install config-keys block (~268-300), Example-clients autopilot.ts entry (~580-609), `## Architecture` worker fleet (~712-1091, worker count ~:1068)

**Optional** (reference as needed):
- The existing v41/v40/v39 schema-history lines in CLAUDE.md (the append template)

### Risks

- CLAUDE.md says "five worker threads", README says "seven" — both already stale; reconcile to the correct count after this epic.
- AGENTS.md is a symlink to CLAUDE.md — edit in place, never rm+recreate.

### Test notes

- Prose only. Verify the worker count is consistent across CLAUDE.md + README and the autoclose flag default (off) is documented.

## Acceptance

- [ ] CLAUDE.md: synthetic events + dispatch_failures projection + the two RPCs + v42 history + corrected worker count
- [ ] README.md: config keys, thin-viewer Example-clients entry, Architecture worker-fleet + synthetic-event updates
- [ ] Worker count consistent across both docs; AGENTS.md symlink untouched

## Done summary
Updated CLAUDE.md (BEGIN IMMEDIATE projection list, synthetic-event sole-writer enumeration, DO NOT RPC-scoped-surface paragraph widened to four surfaces) and README.md (Install config keys, thin-viewer Example-clients entry, Architecture eighth-worker reconciler paragraph + v42 schema-history line + readiness-client-side note) to reflect the server-side autopilot reconciler. AGENTS.md symlink untouched.
## Evidence
