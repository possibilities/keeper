---
name: close
description: >-
  Close a plan epic — run the quality audit, address any findings, then
  finalize the close. Use when the human types `/plan:close <epic_id>` once
  every task in the epic is `done`.
argument-hint: "<epic_id> [instructions]"
allowed-tools: Bash(keeper plan:*), Read, Task, SendMessage
disallowed-tools: Edit, Write, NotebookEdit, TodoWrite
disable-model-invocation: true
---

# Close

Content-blind coordinator for the epic-close phase. The closer drives PROCESS only: it speaks in typed envelopes (refs, hashes, counts, outcomes) and one-line agent returns, and never holds or reasons over the audit report, the verdict JSON, or the follow-up plan. Every pipeline artifact persists as a file under gitignored `<primary_repo>/.keeper/state/audits/<epic_id>/`, written by the submit verbs at emission. The closer passes paths, never contents.

The human types `/plan:close <epic_id>` once every task in the epic is `done`. The session is named `close::<epic_id>`.

`keeper plan close-finalize` encodes the saga from observable state: it stale-checks the source commit set, halts on a `fatal` verdict, and runs the reversible follow-up scaffold BEFORE the irreversible `epic close`. After the agents return, the closer's job is one `close-finalize` call and a total switch over its four outcomes.

---

## Phase 1 — Preflight

Pass `$ARGUMENTS` as a single quoted token to `close-preflight` — the verb owns id validation, readiness, and the brief handoff. No Phase-1 validation ladder, no `cd`:

```bash
keeper plan close-preflight "$ARGUMENTS"
```

**Single failure pattern.** On ANY `{"success": false, "error": {"code", "message", "details"}}` envelope, surface `error.message` verbatim and stop. This covers every reject the verb owns — bad/missing/ambiguous id (`BAD_TASK_ID` / `EPIC_NOT_FOUND` / `AMBIGUOUS_EPIC_ID`), a task-id passed where an epic was required, `TASKS_NOT_DONE` (the epic has open tasks), and `SNIPPET_RENDER_FAILED` / `COMMIT_LOOKUP_FAILED`. The human investigates before any agent spawns. For an `AMBIGUOUS_EPIC_ID`, re-run with `keeper plan close-preflight "$ARGUMENTS" --project <path>`.

**On success**, pin these envelope fields — process facts only, no prose:

- `primary_repo` — plan state repo; passed to the close-planner and to `close-finalize --project`.
- `brief_ref` — close-phase brief JSON (`<primary_repo>/.keeper/state/audits/<epic_id>/brief.json`). Both agents read it themselves; the closer never opens it. It carries the task list, done summaries, and commit groups out-of-band.
- `commit_set_hash` — canonical pin of the source commit set; the closer does not act on it (the submit verbs stamp it; `close-finalize` re-checks it for staleness).
- `epic_id` — the parent epic id (echo of the validated input).

Capture the `[instructions]` tail (anything after the epic id in `$ARGUMENTS`) verbatim as `INSTRUCTIONS` if present — it rides into the close-planner spawn as an opaque directive.

---

## Phase 2 — Audit (spawn quality-auditor blind)

Spawn the quality-auditor with a config-only prompt — `EPIC_ID`, `PRIMARY_REPO`, and `BRIEF_REF`, nothing else. The auditor reads the brief itself (commit groups, done summaries) and persists its report via `audit submit --project "$PRIMARY_REPO"` (so the report resolves to primary even when the close runs from a lane); the closer never inlines audit prose.

```
Task(
    subagent_type="plan:quality-auditor",
    description="Audit <epic_id>",
    prompt="""EPIC_ID: <epic_id>
PRIMARY_REPO: <primary_repo>
BRIEF_REF: <brief_ref>"""
)
```

No `model=` kwarg — the agent file owns the model and effort.

**Transient-failure retry (backoff, not once-then-stop).** The auditor is the expensive, overload-prone step, and the audit runs INLINE — a dropped spawn blocks the whole close, so a "retry once" policy hands a transient API blip back to the human as a dead close. When the Task call fails with no body returned (harness drop, model unavailable, `API Error: 529 Overloaded`), retry with increasing backoff: re-spawn immediately once, then on continued failure sleep `60s → 180s → 600s` between attempts (up to ~5 attempts total). Surface a one-line status to the human before each backoff sleep (*"auditor hit a transient 529; backing off Ns before retry M of 5"*) so a long outage is visible, not silent. Stop only after the backoff budget is exhausted — *"BLOCKED: TOOLING_FAILURE — quality-auditor unreachable after 5 attempts over ~15 min (last error: <verbatim>). Re-run `/plan:close <epic_id>` once the API recovers; `close-finalize` is idempotent so re-run is safe."* A non-transient Task failure (a returned error body that is not an overload/availability blip) stops immediately — backoff is for transient unavailability only.

**Parse the one-line return.** The auditor returns exactly one line: `report_ref=<path> risk=<level> findings=<N>`. Extract `findings` with `findings=(\d+)`:

- `findings=0` → no findings. Skip Phase 3 and go straight to Phase 4 (finalize).
- `findings>0` → go to Phase 3 (spawn the close-planner).
- **Unparseable return** (no `findings=` match) → fail-safe to findings>0: spawn the close-planner. A garbled auditor line must never silently skip the vet step.

---

## Phase 3 — Plan (spawn close-planner blind)

Only when `findings>0` (or the auditor line was unparseable). Spawn the close-planner with a config-only prompt — `EPIC_ID`, `PRIMARY_REPO`, `BRIEF_REF`, and (when present) the `[instructions]` tail as an opaque directive. The planner reads the brief and the auditor's report by path (`audits/<epic_id>/report.md`), vets every finding, and persists the verdict + follow-up plan via `verdict submit` / `followup submit`. The closer passes no report prose.

```
Task(
    subagent_type="plan:close-planner",
    description="Plan follow-up for <epic_id>",
    prompt="""EPIC_ID: <epic_id>
PRIMARY_REPO: <primary_repo>
BRIEF_REF: <brief_ref>

<INSTRUCTIONS verbatim as an opaque directive, omitted entirely when absent>"""
)
```

No `model=` kwarg — the agent file owns the model and effort.

**Capture the planner's agentId** from the Task tool result string. It ends with `…agentId: <hex> (use SendMessage with to: '<id>' to continue this agent)`. Extract with `agentId:\s*([a-f0-9]{10,})` (the hex has no newline before it — `re.search`, not `re.match`). Pin it as `planner_agent_id` for the warm-resume path below.

**Parse the planner's one-line return:**

- `fatal=true reason="<…>" verdict_ref=<path>` → the planner flagged a ship-block. The verdict is persisted; finalize reads it and halts. Go to Phase 4.
- `fatal=false kept=K culled=C merged=M …` (with or without `followup_ref`) → the verdict (and follow-up plan when survivors exist) is persisted. Go to Phase 4.
- `QUESTION: <text>` → the planner needs one judgement call answered. Nothing is persisted yet. Handle per the QUESTION protocol below.

### QUESTION protocol

The close-planner returns `QUESTION: <text>` when a single judgement call would flip a verdict and it has exhausted its escape-hatch ladder. Nothing is persisted before a QUESTION.

**Surface and pin.** Relay the question to the human verbatim, then end the turn with `planner_agent_id` pinned. Do not finalize, do not close. **Under autopilot, QUESTION behaves like BLOCKED** — the chain halts, the epic stays open, no `close-finalize` fires; a human picks it up later.

**On the human's answer (warm resume):** send the answer to the pinned agent (fire-and-forget):

```
SendMessage(to=planner_agent_id, message="ANSWER: <human's answer>")
```

Wait for the planner to finish, then re-parse its one-line return (fatal / non-fatal / a fresh QUESTION) and continue. A SendMessage error envelope `{"success": false, "message": "No agent named '<id>' is currently addressable..."}` means the agent is dead — fall through to the cold path.

**Cold fallback (SendMessage error, or a fresh session with no pinned id):** re-spawn the close-planner against the persisted artifacts, folding the answer into the prompt. The report and (any) prior verdict still live at their refs under `audits/<epic_id>/`, so the planner re-reads them by path:

```
Task(
    subagent_type="plan:close-planner",
    description="Resume plan for <epic_id>",
    prompt="""EPIC_ID: <epic_id>
PRIMARY_REPO: <primary_repo>
BRIEF_REF: <brief_ref>

ANSWER (to your prior QUESTION): <human's answer>"""
)
```

Re-parse the return and continue.

---

## Phase 4 — Finalize (the saga)

Run `close-finalize` — one call that encodes the whole saga from observable state. It re-checks the commit-set hash for staleness, halts on a `fatal` verdict, runs the reversible follow-up scaffold (when survivors exist), and only then runs the irreversible `epic close`. Pass `--project` from the preflight `primary_repo` (no `cd`):

```bash
keeper plan close-finalize <epic_id> --project <primary_repo>
```

`close-finalize` is idempotent — a re-run after a crash derives its position from observable state (a closed epic, an existing follow-up) and never double-creates. It refuses on a `commit_set_hash` mismatch (a commit landed after the audit) rather than closing against stale artifacts.

**Total switch over the four `CloseOutcome` members** (`data.outcome` on the success envelope). The switch MUST stay total — the task-3 exhaustiveness test enforces it; if an outcome is added, update both this switch and that test together:

- **`closed_clean`** → the epic closed with no follow-up (no findings, or every finding culled). Report the clean format.
- **`closed_with_followup`** → the epic closed and a follow-up epic was scaffolded. Read `data.new_epic_id`. Report the with-followup format.
- **`fatal_halt`** → the planner flagged a ship-block; the epic stays OPEN, nothing closed. Read `data.fatal_reason`. Report the fatal-halt format.
- **`partial_followup`** → a prior `/plan:close` crashed mid-scaffold and left an incomplete follow-up (`data.expected_tasks` vs `data.actual_tasks`). The epic stays OPEN. Surface it and stop: *"Partial follow-up for `<epic_id>` (expected `<expected_tasks>` tasks, found `<actual_tasks>`). A prior `/plan:close` crashed mid-scaffold. Inspect and complete or delete it, then re-run `/plan:close <epic_id>`."*

**Typed errors** — on a `{"success": false, "error": {"code", "message", "details"}}` envelope, surface `error.message` verbatim and stop. The codes include `STALE_ARTIFACTS` (the source commit set moved since the audit — re-run `/plan:close` to re-audit), `VERDICT_MISSING` / `VERDICT_CORRUPT`, `FOLLOWUP_MISSING`, `SCAFFOLD_FAILED`, and `EPIC_NOT_FOUND`. None of these are retried by the skill — the human reads the message and acts.

---

## Report

One line, three formats.

Clean close (no findings, or all findings culled):

```
Closed `<epic_id>`. No followup epic created.
```

Close with follow-up (findings survived the cull):

```
Closed `<epic_id>`. Audited inline → planned `<new_epic_id>`.
```

Fatal halt (`fatal_halt` outcome — epic NOT closed):

```
Halted `<epic_id>`. fatal finding: <fatal_reason>. epic NOT closed.
```

The `## Audit decisions` table on the follow-up epic (visible via `keeper plan cat <new_epic_id>`) plus its `depends_on_epics: ["<source>"]` are the durable trace of what the audit decided and why — the closer never writes to the source spec.

---

## Out of scope

- **No report/verdict/follow-up prose in the closer's context** — every artifact lives on disk under `audits/<epic_id>/`; the closer holds refs, hashes, counts, and one-line agent returns only.
- **No saga logic in the skill** — `close-finalize` owns stale-check, fatal-halt, scaffold-before-close ordering, and idempotency. The skill spawns agents and switches on the typed outcome.
- **No closer-driven worker dispatch** — surviving findings become tasks in the planner's scaffolded follow-up epic, dispatched by autopilot like any other ready work.
- **No write to the source epic body** — provenance lives on the follow-up's `depends_on_epics` and its `## Audit decisions` table; the planner's `fatal` flag is the only ship-block gate.
- **No retry on a typed `close-finalize` error**, and **no `Skill(plan:plan)` dispatch** — surface verbatim and stop — `close-finalize` is idempotent, so a re-run is safe.
