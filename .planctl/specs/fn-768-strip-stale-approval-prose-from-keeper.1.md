## Description

**Size:** S
**Files:** README.md, CLAUDE.md (keeper; AGENTS.md is a symlink to it — edit in place, never rm+recreate), /Users/mike/code/planctl/CLAUDE.md

### Approach

Doc-only cleanup of prose the fn-756 strip orphaned. Delete, don't tombstone
(present-tense house style — no "formerly…/removed in fn-N").

keeper **README.md** (~25 refs): remove the `set_task_approval` /
`set_epic_approval` RPC descriptions, the `approval` field on the subscribe
frame (~:116), the PERMANENT ladder prose (~:188-190), the board
`[approval]` pill docs, and the "writes the approval field to the gitignored
sidecar" passages (~:181-270). The `## Architecture` RPC surface should no
longer list approval; tasks/epics no longer carry an `approval` projection
field.

keeper **CLAUDE.md** (8 refs): the "RPC may write ONLY six surfaces" list
(~:92) currently counts `approval` as item (1) — drop it and **renumber to
FIVE** (replay_dead_letter, retry_dispatch, set_autopilot_paused,
set_autopilot_mode, set_epic_armed). Delete the entire "Plans are READ-ONLY
except `approval`" paragraph (~:103-113), the PERMANENT ladder, and
`set_{task,epic}_approval`. Fix the stale "pending-approval rows can't
deadlock the approvers" line (~:232). Note CLAUDE.md is already
half-updated (line ~272 reflects the new no-approval-gate completion) — make
the whole file internally consistent.

planctl **CLAUDE.md line 62**: drop `approve`, `render-approve-context`,
`task ack`, `epic ack`, `epic.approval`/`task.approval` fields, and the
`acks.db` ack store from the retired-grammar list. (Cross-repo one-liner —
commit it in the planctl repo separately from the keeper doc commit.)

### Investigation targets

**Required** (read before coding):
- README.md:116, :181-190, :223-270 — approval RPC/ladder/sidecar prose + board pill docs
- CLAUDE.md:89-113 — "Writes are tightly scoped" six-surfaces list + Plans-read-only-except-approval para
- CLAUDE.md:232, :272 — stale approver line + the already-updated completion-reap line (consistency anchor)
- /Users/mike/code/planctl/CLAUDE.md:62 — retired-grammar list still naming approve/ack/approval

## Acceptance

- [ ] `grep -ci approval` on keeper README.md and CLAUDE.md returns 0 (or only unavoidable historical-migration mentions, named in Done summary).
- [ ] The "writes ONLY … surfaces" list reads FIVE, renumbered (1)-(5), with no approval item.
- [ ] No `set_task_approval`/`set_epic_approval`/PERMANENT-ladder/`[approval]`-pill prose remains; planctl CLAUDE.md:62 no longer lists the removed verbs/fields.
- [ ] AGENTS.md still resolves as a symlink to CLAUDE.md (not replaced by a regular file).

## Done summary

## Evidence
