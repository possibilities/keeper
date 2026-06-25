## Description

**Size:** M
**Files:** src/daemon.ts, test/daemon.test.ts, plugins/plan/skills/plan/SKILL.md, plugins/plan/template/skills/work.md.tmpl, plugins/plan/template/agents/worker.md.tmpl, plugins/keeper/skills/bus/SKILL.md, README.md (+ regenerated plugins/plan/skills/work/SKILL.md, plugins/plan/agents/worker-{high,medium,xhigh,max}.md)

Rewrite the blocked-worker escalation loop so a planner resumes the still-live `/work` agent in-context via the Agent Bus (PRIMARY), keeping autopilot cold-re-dispatch as the FALLBACK for a dead worker. This is a coordinated, consistency-critical edit: the same "cold-re-dispatch only / do not reply" story is repeated across the daemon directive, the planner skill, the work skill, the worker agent, and the README — every instance must move to the unified PRIMARY/FALLBACK description; leaving one stale is a bug. Forward-facing wording only (no "used to say X" narration in prose; the commit message carries the before/after).

### Approach

Two-hop, two-transport model — keep these DISTINCT (the highest-value correctness point):
1. keeperd → `planner@<epic>` over the bus — the existing escalation (`notifyPlannerOfBlock`), text built by `buildBlockEscalationBody`. Unchanged transport; only the directive TEXT changes.
2. planner session → `work::<taskId>` over the bus — the NEW primary. `work::<taskId>` is the `/plan:work` ORCHESTRATOR session's `--name` (autopilot-worker.ts:266), NOT the inner Task subagent. The orchestrator, woken by this bus directive, re-enters its EXISTING Phase 2b warm-resume — `SendMessage(worker_agent_id, …)`, a different intra-session transport — to continue the original worker subagent with full context, cold-spawning a fresh subagent in-session only if that SendMessage misses.

Concrete edits:
- **`src/daemon.ts` `buildBlockEscalationBody` (~L557):** replace the "autopilot then cold-re-dispatches a fresh worker — NO reply needed, do not reply to this message" lines. New body: after addressing the blocker, `keeper plan unblock <taskId>`, THEN `keeper bus chat send work::<taskId> "RESOLVED: <what changed> — resume now"` (or special instructions if the resolution changes the work); name the fallback — a `not_connected`/`unknown_target` send result means the worker session is gone, so the board-unblock lets the autopilot cold-re-dispatch a fresh worker (or run `keeper dispatch work::<taskId>` if the autopilot is paused). Tighten the JSDoc (~L549-555) — it is no longer a one-way directive. The function stays a pure body builder; `notifyPlannerOfBlock` (the send seam) needs no logic change.
- **`test/daemon.test.ts` (~L3094 "buildBlockEscalationBody: carries …"):** drop `expect(body).toContain("NO reply needed")`; assert the resume instruction `expect(body).toContain("keeper bus chat send work::fn-9-foo.2")`; keep the `keeper plan unblock fn-9-foo.2` assertion. Leave `shouldEscalateBlockedCategory` + the `runBlockEscalationSweep` tests unchanged.
- **`plugins/plan/skills/plan/SKILL.md` (PRIMARY deliverable; hand-maintained, NO template/sidecar):** add a short lifecycle section "Reacting to a blocked-worker bus directive", near the Cross-skill orchestration awareness subsection (~L566) or as a standalone post-Phase-8 section. Content: when a blocked-worker escalation wakes you (the authoritative `Plan task … is BLOCKED and needs you` bus directive), (1) resolve the blocker per its category (human-gated action / clear the dep / refine the spec via `/plan:plan <epic> refine` / whatever the category calls for), (2) `keeper plan unblock <task>`, (3) PRIMARY: `keeper bus chat send work::<task> "…resume…"` — a `delivered` result (exit 0) means the live worker resumes in-context, done; (4) FALLBACK: a `not_connected`/`unknown_target` result (exit 1) means the worker session has died — the board-unblock you already did lets the autopilot cold-re-dispatch a fresh worker (manual `keeper dispatch work::<task>` if the autopilot is paused). Make the precedence explicit (bus-resume first; cold-re-dispatch only on a miss). Cite the bus result tokens from the keeper bus skill.
- **`plugins/plan/template/skills/work.md.tmpl` Phase 2c (~L171-183) + Guardrails (~L207):** keep "stamp the block, surface, stop" and keep the wielder-never-SENDS-on-the-bus guardrail (the wielder RECEIVES a resume, never sends one). Replace the post-unblock fate description ("the worker cold-re-dispatches via the autopilot once the planner unblocks the task. No bus send, no wake, no yield, no resume machinery in this skill") with: the orchestrator ends its turn but stays REACHABLE (its `keeper bus watch` inbox Monitor is armed); when a planner resume bus directive arrives, re-enter the Phase 2b warm-resume (SendMessage the original subagent → cold-spawn-in-session fallback) after a `keeper plan reconcile <task>` confirms the task is unblocked; the autopilot cold-re-dispatch is the fallback for when this orchestrator session is gone. Then regenerate the managed `plugins/plan/skills/work/SKILL.md`.
- **`plugins/plan/template/agents/worker.md.tmpl` (~L221 "Never end a turn text-only to wait" + ~L29-40 "Resume directives outrank everything below"):** RECONCILE, don't contradict. The SUBAGENT still returns `BLOCKED: <CATEGORY>` and never idle-waits — unchanged. Add one clarifying line that returning BLOCKED hands the wait to the PARENT orchestrator session (which holds the paired bus-inbox wake), and the parent may later re-engage this subagent with a resume directive — already covered by "Resume directives outrank everything below". Then regenerate the managed `plugins/plan/agents/worker-*.md`.
- **`plugins/keeper/skills/bus/SKILL.md`:** one brief note that a dispatched plan worker's live session is addressable by its deterministic `work::<taskId>` (and `close::<epic>`) name — so a planner can reach a still-live blocked worker — and that a miss (`not_connected`/`unknown_target`, exit 1) on such a plain name means the session is gone (NOT queued, unlike a `planner@<epic>` send). Keep it tight; `work::<task>` is a plain session name, not a new special role.
- **`README.md` block-escalation narrative (~L3011-3028, esp. the "no warm resume, no orchestrator in the loop" parenthetical):** revise to the two-path PRIMARY/FALLBACK flow. Do NOT touch the autopilot/window-reaper section (~L433-460) — fn-959 owns that region and it already documents the verdict-gated reaper correctly.
- **Autopilot VERIFY (READ-ONLY):** confirm end-to-end that a blocked-but-alive worker is neither cold-re-dispatched (live-pane occupancy gate, `isOccupyingJob` autopilot-worker.ts:866) nor reaped (verdict-gated window-reaper) while its window lives, and that the fn-934 orphan-reaper arm does not target an idle TRACKED worker. Document the intent in the surfaces above. Do NOT edit `src/autopilot-worker.ts` (fn-959 owns it). If the verify finds an ACTUAL gap, STOP and surface it via `BLOCKED:` rather than silently expanding scope.

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:549-578 — `buildBlockEscalationBody` + JSDoc (the directive to rewrite)
- src/daemon.ts:4383 — `notifyPlannerOfBlock` (confirm the seam is body-only; no send-logic change)
- test/daemon.test.ts:3094 — directive-body test to update (and ~3230 fakeSweepDeps, leave as-is)
- plugins/plan/skills/plan/SKILL.md:566 — Cross-skill orchestration awareness (placement anchor)
- plugins/plan/template/skills/work.md.tmpl:171-183, 207 — Phase 2c + Guardrails
- plugins/plan/template/agents/worker.md.tmpl:29-40, 221 — resume-directive + never-text-only-wait rules
- cli/bus.ts:766-847 — `keeper bus chat send` result tokens; `sendResultIsSuccess` :822 — cite verbatim
- src/autopilot-worker.ts:266, 866 — `work::<task>` name + `isOccupyingJob` live-pane gate (read-only verify)
- README.md ~L3011-3028 — block-escalation producer narrative (grep "no warm resume" / "cold-re-dispatches a fresh worker")

**Optional** (reference as needed):
- plugins/keeper/skills/bus/SKILL.md — bus addressing (for the `work::<task>` note)
- plugins/prompt/src/render_plugin_templates.ts, plugins/prompt/test/parity.test.ts — render + parity gate

### Risks

- **Transport conflation (highest):** the bus reaches the ORCHESTRATOR `work::<task>` session; the orchestrator's SendMessage warm-resume reaches the inner SUBAGENT. Two transports, two hops — prose must not imply the planner SendMessages the subagent, or that the bus reaches the subagent directly.
- **Double-dispatch:** must NOT introduce one. Safety rests on the EXISTING live-pane occupancy gate (`isOccupyingJob` — while the worker pane is live the autopilot won't cold-re-dispatch) plus `work::<task>` being a non-queued ephemeral send (a miss doesn't replay to a later epoch). Do NOT add a state-machine / fencing token / RESUMING sentinel — that would widen the forbidden reducer write path and is out of scope. Document the safety argument; don't engineer new machinery.
- **fn-952 file entanglement:** `src/daemon.ts` + `test/daemon.test.ts` carry in-flight uncommitted fn-952 work; the epic dep on fn-952 should yield a clean tree at execution. If those files are still dirty with non-session changes, use the commit-work escape hatch (explicit `git add <path>`), never `-A`/`.`.
- **fn-959 overlap:** keep autopilot work read-only and edit only the block-escalation README narrative (not the autopilot/reaper section) to avoid colliding with fn-959's autopilot rewrite.

### Test notes

- `bun test test/daemon.test.ts` — directive-body assertion flip + sweep tests stay green.
- After editing templates: `keeper prompt render-plugin-templates --project-root "$(pwd)"`, then `cd plugins/prompt && bun test` (parity + check_generated — these are path-ignored from keeper's test:full, so run them explicitly).
- `bun run test:full` (mandatory — daemon/template/hook paths).
- Final grep `grep -rn "NO reply needed\|do not reply\|no warm resume\|cold-re-dispatches a fresh worker" src/ plugins/ README.md` returns nothing.

## Acceptance

- [ ] `buildBlockEscalationBody` instructs `keeper plan unblock <task>` then `keeper bus chat send work::<task>` resume, names the dead-worker cold-re-dispatch fallback, and drops "do not reply"; its JSDoc no longer claims a one-way directive. `test/daemon.test.ts` updated in lockstep (drops the "NO reply needed" assertion, asserts the bus-resume instruction).
- [ ] `plugins/plan/skills/plan/SKILL.md` documents the planner reaction: resolve → `keeper plan unblock <task>` → bus-resume `work::<task>` (PRIMARY, exit-0 delivered) → cold-re-dispatch FALLBACK on an exit-1 miss, with explicit precedence and the send-result branch.
- [ ] `work.md.tmpl` + `worker.md.tmpl` accommodate the planner bus-resume (orchestrator stays reachable post-block and re-enters its warm-resume; subagent "never text-only wait" rule reconciled, not contradicted); the wielder-never-sends-on-the-bus guardrail stays intact; managed files regenerated and check_generated/parity green.
- [ ] `plugins/keeper/skills/bus/SKILL.md` notes `work::<task>` addressing + miss-means-gone; `README.md` block-escalation narrative updated to PRIMARY/FALLBACK; the autopilot/window-reaper README section is left untouched.
- [ ] No new reducer/RPC write path; double-dispatch safety documented via the existing occupancy gate; autopilot verified read-only (or a real gap surfaced via BLOCKED); `bun run test:full` + prompt-plugin parity green.

## Done summary

## Evidence
