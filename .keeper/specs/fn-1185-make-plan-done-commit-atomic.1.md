## Description

**Size:** M
**Files:** plugins/plan (done verb implementation), src (projection fold if the event shape changes), test

### Approach

Find the `keeper plan done` write path and make the durable order commit-first: the done
event (or whatever feeds `runtime_status: done` into the daemon projection) must not become
visible unless the `.keeper` state-file commit landed. Where the commit can fail for
environmental reasons (the shared checkout mid-merge — MERGE_HEAD present), prefer
detect-and-retry/defer over failing half-way. Add a sanctioned unwind for the already-wedged
shape (projection done, disk todo): either the done verb self-heals by re-writing the
missing state files when it detects projection-done-disk-null, or a narrow reconcile flag
does. Keep the plans-are-read-only RPC discipline — this is a CLI/state-file ordering fix,
not a new write surface into the reducer.

### Investigation targets

*Verify before relying — the repo moves.*

**Required** (read before coding):
- The `keeper plan done` implementation (plugins/plan tree) — locate where the event/projection write and the git commit each happen today
- The "already done" guard that refuses both done --force and block
- The stuck-sentinel (worker-done-while-working) machinery in src — the detector that flagged this class

### Risks

- The projection's done may come from a live event a worker emits rather than the CLI — if so the fix point is different (gate the fold or the emit on commit outcome); confirm the actual data flow before restructuring.

## Acceptance

- [ ] Reproduction test: a failing state-file commit leaves the task recoverable via CLI (no operator hand-edit)
- [ ] The mid-merge window is explicitly handled (retry/defer/loud-fail — never a half-stamp)
- [ ] The projection-done-disk-null wedge has a sanctioned CLI recovery, tested
- [ ] Full fast suite green

## Done summary
Made keeper plan done durable-or-nothing: a failed state-file commit (the mid-merge shared-checkout window) unwinds the spec/runtime/worker_done_at writes so no half-stamped done survives, and a done re-run self-heals an already-wedged STATE_UNCOMMITTED task by re-committing the missing backing instead of refusing 'already done'. Added a regression suite proving the unwind, the recovery re-run, and the self-heal.
## Evidence
