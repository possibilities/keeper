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

Your work agents ask you for help. Either the daemon escalates a blocked `/plan:work` worker to you ONCE over the Agent Bus — a `Plan task <task> (epic <epic>) is BLOCKED — the worker exhausted its own resolution and escalated rather than guess.` message carrying the `Category:`, `Repo:`, and verbatim `Blocked reason:` — or a still-live worker messages you directly. Either way, be prepared to do the work the resolution needs on the worker's behalf, then hand control back and ask it to resume. React in this order — **bus-resume is PRIMARY; cold-re-dispatch is the fallback, not the default**:

1. **Resolve the blocker per its category** — do the human-gated action, clear the dep, refine the spec (`/plan:plan <epic> refine`), or whatever the `Category:` line calls for. The directive carries the verbatim `blocked_reason`.
2. **Unblock the board** — `keeper plan unblock <task>` (flips the task `blocked → todo`, preserving claim history).
3. **PRIMARY — resume the still-live worker in place over the bus:**

   ```bash
   keeper bus chat send work::<task> "RESOLVED: <what changed> — resume now"
   ```

   `work::<task>` is the still-live `/plan:work` orchestrator session's deterministic name. A `delivered` result (exit 0) means that session picks the task back up in-context with everything it already figured out — done. Say more than "resume now" if the resolution changed the work.
4. **FALLBACK — only on a miss:** a `not_connected`/`unknown_target` send result (exit 1, per `keeper:bus`'s result tokens) means that worker session has died. The `keeper plan unblock` you already did lets the autopilot cold-re-dispatch a fresh worker; if the autopilot is paused, run `keeper dispatch work::<task>` yourself.

Precedence is strict: try the bus-resume FIRST and fall through to cold-re-dispatch ONLY on the exit-1 miss. Do not pre-check `keeper bus list` — send blindly and branch on the send's own result. Resuming a live worker reuses its accumulated context; cold-re-dispatch discards it, so it is the genuinely-dead-worker path only.

**Designing deliberate check-ins (plan-time).** A task spec MAY name a deliberate check-in point where the worker returns `BLOCKED: DESIGN_CONFLICT` or `SPEC_UNCLEAR` at a genuine fork rather than guessing — the daemon wakes `planner@<epic>` once per block instance with the same resume recipe above (bus-resume PRIMARY, cold-re-dispatch the fallback). Two caveats carry over from the escalation mechanics: `TOOLING_FAILURE` and an absent or unparseable category never escalate — that's a surface-and-stop that mints a silent sticky suppression instead of paging you; and the wake reaches only a known creator edge — an offline-but-known creator is queued and auto-woken, a purged or foreign creator receives nothing.
