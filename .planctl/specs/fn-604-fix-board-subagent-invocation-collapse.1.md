## Description

Originates from finding F1 in the `/plan:close` audit of
`fn-601-board-readiness-pill`.

The wire descriptor at `src/collections.ts:296-313`
(`SUBAGENT_INVOCATIONS_DESCRIPTOR`) declares `pk: "job_id"` over a
collection whose composite identity is `(job_id, agent_id, turn_seq)`
— re-entrant sub-agents in one session land on distinct rows via the
per-job monotone `turn_seq` counter. The board's frame handler at
`scripts/board.ts:687-691` does `state.byId.set(id, row)` with
`id = String(row[state.pk])` — i.e. `String(row.job_id)` — so
multiple invocations sharing a `job_id` collapse last-write-wins to
one row in `byId`. The readiness call site at `scripts/board.ts:621`
iterates `subagentInvocations.byId.values()` and hands the result to
`computeReadiness`, which builds its
`subRunningByJobId: Map<string, SubagentInvocation[]>` index at
`scripts/readiness.ts:110-117` — but the array can only hold what
the caller provided.

Result: predicate 6 (`own-progress-sub`) systematically misses some
sub-agent invocations on sessions with re-entrant sub-agents — the
exact case the descriptor's own header comment at
`src/collections.ts:295-302` calls out — and the board pill can flip
to `[ready]` while a sub-agent is still running.

Pick one of the auditor's suggested approaches:
(a) retain `frame.rows` on the state and iterate the raw array
instead of `byId.values()` for this collection — least invasive,
since the readiness pipeline only needs an iterable; or
(b) rekey `byId` for `subagent_invocations` to the composite
`${job_id}|${agent_id}|${turn_seq}` so `byId.values()` returns every
row — keeps the byId-driven invariant uniform across collections.

Either approach lands the same outcome: every invocation row reaches
`computeReadiness`.

## Acceptance

- [ ] Every `SubagentInvocation` row delivered in a `result` frame
      reaches `computeReadiness`; no `job_id`-keyed collapse.
- [ ] A test (in `test/board.test.ts` or `test/readiness.test.ts`,
      depending on where the fix lives) constructs a session with
      two `running` invocations sharing one `job_id` and asserts
      the readiness verdict is `[blocked:sub-agent-running]`.
- [ ] `bun run tsc --noEmit` is clean; `bun test` passes.

## Done summary

## Evidence
