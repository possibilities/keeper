# Operator orchestration — driving multi-epic execution and unblocking workers

Detail disclosed from `SKILL.md` Phase 6. The planning happy path never pays for this
prose — you land here only on an operator branch: the human asks how a multi-epic plan
should EXECUTE, or a work agent escalates a blocked task to you. Both are cross-skill
concerns the operator skills own, not the planning flow.

## Cross-skill orchestration awareness (multi-epic)

When the plan spans more than one epic, how those epics EXECUTE is a cross-skill concern the operator skills own — not this planning flow. Wire the topology into the plan itself; never proactively launch execution mid-plan. Reach for the operator skills only on clear user intent (they are model-invocable), referencing them for mechanics:

- **Parallel** (dep-free epics) → scaffold both; `keeper:autopilot mode yolo` dispatches them concurrently.
- **Sequential** (B after A) → the `epic.depends_on_epics` edge wired in Phase 6 sequences execution under autopilot; a stricter human-gated cadence is `keeper:autopilot mode armed` plus a `keeper:await complete <epic>` phase gate.
- **Planning-dependent daisy-chain** (B genuinely unplannable until A lands) → arm `keeper:await landed fn-A`, then re-enter planning for B on `met`. Gate on `landed` (lane merged to default), not `complete` — for why the two milestones diverge (worktree finalize timing, multi-repo groups, worktree-off degrade): <!-- POINTER: keeper prompt render engineering/landed-vs-complete -->.
- **Take-over window** → `keeper:autopilot` captures `{paused, mode, armed}`, drives by hand, restores; `keeper:dispatch` fires one worker.
- **Research epics** (the deliverable is knowledge, not code) → scaffold a normal epic; follow-ups gate on `complete` — the section's `landed`-vs-`complete` POINTER above already covers why research epics use the earlier milestone. Spec-time rule: every research task names its retrieval path, defaults acceptance-criteria writes to `~/docs/<slug>.md`, and closes with a lightweight Done summary. A bounded one-shot ask doesn't warrant a plan epic at all — reach for `keeper:handoff` or `keeper:pair` instead.

The planning flow's default wrap-up stays quiet (Phase 8) — these shapes engage only on the human's request.

## Helping a blocked work agent

A `/plan:work` worker that exhausts its own resolution returns a typed `BLOCKED: <CATEGORY>` and stamps the task blocked. The daemon answers autonomously: a blocked task whose category is escalatable dispatches ONE `unblock::<task>` escalation session (sonnet/high, the `/plan:unblock` skill), SERIALIZED per epic so a burst of blocks in one epic never runs more than one live unblock session at a time. That session loads its incident brief (`keeper escalation-brief unblock::<task>`) and resolves the block without the creator's context. Two cases never escalate — `TOOLING_FAILURE` and an absent or unparseable category are a surface-and-stop that mints a silent, operator-visible sticky suppression instead of dispatching.

**Your surface is the terminal page, not the block itself.** agentbot pages you EXACTLY once, and only when the `unblock::<task>` session itself declines (stamps BLOCKED) or dies — the block outlived the autonomous attempt. When paged:

1. **Resolve the blocker per its category** — do the human-gated action, clear the dep, refine the spec (`/plan:plan <epic> refine`), or whatever the category calls for. `keeper escalation-brief unblock::<task>` carries the verbatim blocked reason plus the creator lineage.
2. **Unblock the board** — `keeper plan unblock <task>` (flips the task `blocked → todo`, preserving claim history); the leave-blocked clear re-arms the whole escalation marker chain at null.
3. **Re-dispatch** — `retry_dispatch` on the sticky drops the suppression row so autopilot cold-re-dispatches a fresh worker; if the autopilot is paused, run `keeper dispatch work::<task>` yourself.

A block the daemon could not escalate (`TOOLING_FAILURE` / unparseable) never pages you — its sticky suppression stays operator-visible on the board for you to notice and clear. A still-live worker MAY also message you directly over the bus mid-task; answer in place and hand control back.

**Designing deliberate check-ins (plan-time).** A task spec MAY name a deliberate check-in point where the worker returns `BLOCKED: DESIGN_CONFLICT` or `SPEC_UNCLEAR` at a genuine fork rather than guessing. Such a block is escalatable, so it dispatches an `unblock::<task>` session like any other — you are reached only if that session also gives up, via the terminal agentbot page above.

## A shared-base breakage: the repair route

A worker whose baseline confirms the shared default branch itself is red — independent of its own diff — returns `BLOCKED: SHARED_BASE_BROKEN` instead of any task-scoped category. That class has no per-task fix and no write access from `unblock`, so it routes to a separate, repo-scoped, write-capable escalation: a `repair::<repo-token>` session, keyed on `(repo, failure-fingerprint)` so every task blocked on the same base defect converges on ONE repair attempt rather than N duplicate ones.

The repair session runs in the shared checkout (never a task lane), re-verifies the defect at current HEAD — a concurrent commit having already healed it is a success path, not a decline — verifies any fix with the full gate, asserts its touched files never overlap an affected task's own declared `Files:` list, and lands a structured commit on trunk before fanning `keeper plan unblock` + a bus resume out to every affected task. It pages you exactly once, only on decline (bounded attempts exhausted, or a non-overlap trip), via the same terminal agentbot page as `unblock`; a still-parked repair incident stays operator-visible until you `retry_dispatch` it. A live worker's own baseline-confirmed `SHARED_BASE_BROKEN` block is otherwise handled the same as any other escalatable category from your seat — you learn about it only if the repair attempt itself gives up.
