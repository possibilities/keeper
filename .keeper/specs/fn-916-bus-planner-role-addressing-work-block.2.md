## Description

**Size:** M
**Files:** plugins/plan/template/skills/work.md.tmpl, plugins/plan/skills/work/SKILL.md (+ .managed-file-dont-edit sidecar, via re-render), plugins/keeper/skills/bus/SKILL.md, cli/bus.ts, README.md

### Approach

Teach the `/plan:work` orchestrator to escalate a semantic block to its planner over the bus, then document the new `planner@<epic>` address on every surface that describes bus targets. Depends on Task 1 (the address must resolve before the skill uses it or the docs describe it as working).

1. **`work.md.tmpl` — widen allowed-tools (`:10`)** by EXACTLY `Bash(keeper bus chat send:*)` (NOT `Bash(keeper bus:*)` — that would permit the forbidden `keeper bus watch`; the inbox is already armed as a session Monitor). `SendMessage` stays (warm worker resume).
2. **Add "Phase 2c — escalate to planner once, then fall back."** Both semantic-block exits funnel into it: the `blocked` reconcile-verdict arm (`:126`) and the `BLOCKED: <category>` short-circuit (`:169`) — change each from "surface and stop" to "→ Phase 2c". Phase 2c:
   - Send blindly (the synchronous send IS the reachability check — no pre-check `keeper bus list`): `keeper bus chat send "planner@<epic_id>" -` with the body on stdin. The body uses the bus hand-off vocab (`LEAD:`/`HANDOFF:`) and carries, verbatim: epic_id, task_id, the `BLOCKED: <category>` breadcrumb, `blocked_reason`, `target_repo`/`primary_repo`, and the full framing — bias the planner toward (a) "do the unblock yourself, commit, then tell me to resume", with (b) "this is part of the plan, resume your worker with <directive>" as the alternative. The body is LOAD-BEARING: "planner" is only a resolution convenience — the receiver has no planner-mode and acts via the ordinary authoritative-bus contract — so all framing must travel in the message.
   - On any non-`delivered` outcome (`not_connected`/`unknown_target`/`ambiguous_target`/`delivery_failed` — the CLI exits 1 on all) → FALL BACK: surface the original BLOCKED breadcrumb verbatim and STOP (today's behavior; the autopilot-headless / planner-absent / self-send-to-creator degrade).
   - On `delivered` → announce "waiting for planner on `<task_id>`" and YIELD (end the turn — "wait means yield, not spin"). NEVER run `keeper bus watch`. The planner's authoritative reply arrives via the already-armed inbox Monitor as a notification that re-invokes the wielder (read any spilled body via `Read`).
   - On the planner's reply → re-run `keeper plan reconcile <task_id>`; if `done`, continue to Phase 3; otherwise route the reply's directive into the worker via the EXISTING Phase 2b machinery (warm `SendMessage(to=worker_agent_id)` if captured this invocation, else cold `keeper plan worker resume`) — path (a) and (b) both end in resume-the-worker; the wielder never touches code. `reconcile` is authoritative for `done` — a planner "I did it" claim that does not reconcile to `done` resumes the worker, it does not re-escalate.
   - Bound: ONE escalation per block. Hold an invocation-local "escalated this block" flag keyed on `(task_id, BLOCKED category)`, mirroring the Phase 2b 5-attempt invocation-local counter. If the post-resume `reconcile` is still `blocked` with the same blocker, surface and stop — never re-escalate (ping-pong / maker-checker livelock guard, layered on the bus loop-stop reflex). Phase 2c is separate from the 5-attempt `in_progress_*` budget (semantic blocks were never in it).
   - Self-send note: if the wielder IS the epic's creator, the bus excludes self from fanout → non-`delivered` → fallback fires (you are already the planner; handle the block directly). State this so it is not surprising.
3. **Reconcile the Guardrails** "never auto-retries a semantic failure" bullet: Phase 2c is an ESCALATION (one bus send + a single planner-directed resume), not a retry loop — clarify rather than contradict.
4. **Re-render**: run `keeper prompt render-plugin-templates`; commit the regenerated `plugins/plan/skills/work/SKILL.md` AND its `.managed-file-dont-edit` sidecar together. NEVER hand-edit the rendered file.
5. **Docs (forward-facing, fold into existing prose — do not grow new paragraphs or imply a new outcome):**
   - `plugins/keeper/skills/bus/SKILL.md` — document `planner@<epic_id>` as a role-address resolution axis alongside name/id/channel/former-name; note an unresolvable one is `unknown_target`/`not_connected` (no new code).
   - `cli/bus.ts` HELP (`:65-111`) + file JSDoc (`:6-10`) — fold `planner@<epic_id>` into the `<target>` description sentence.
   - `README.md` Agent Bus relay section (~`:2943-2986`) — one sentence on role resolution (creator edge → job_id → channel), folded into the existing resolution clause.

### Investigation targets

**Required** (read before coding):
- plugins/plan/template/skills/work.md.tmpl:10 (allowed-tools), :120-169 (verdict switch, Phase 2b resume machinery, the two block exits :126/:169), Guardrails ~:187-196
- plugins/keeper/skills/bus/SKILL.md — send-blindly (~:49), authoritative inbound directive (~:99), `LEAD:`/`HANDOFF:` hand-off vocab (~:124), loop-stop reflex (~:128), never run `keeper bus watch` (~:36)
- plugins/prompt/src/render_plugin_templates.ts:621+ (`runRenderPluginTemplates`) + plugins/prompt/src/cli.ts:199 (`render-plugin-templates` dispatch) — the render seam
- cli/bus.ts:62 / :131 (stdin `-` handling), :65-111 (HELP)

**Optional:**
- README.md ~:2943-2986 (Agent Bus relay resolution prose)
- plugins/plan/skills/work/SKILL.md + sidecar (the render OUTPUT — verify, never hand-edit)

### Risks

- Wait-for-reply feasibility is the crux: the wielder must SEND then YIELD (end its turn) and rely on the armed `keeper bus watch` Monitor to re-invoke it on the reply. Prove this before trusting Phase 2c (early proof point). If a `/work` session cannot resume on an inbound bus notification mid-skill, Phase 2c is inert and must be reconsidered.
- Re-render coupling: a `.tmpl` edit without re-render leaves the rendered SKILL.md stale; commit both together.
- Allowlist scope: `Bash(keeper bus chat send:*)` only — `Bash(keeper bus:*)` would permit `keeper bus watch`, violating the bus skill's contract.
- Doc drift: the three doc surfaces enumerate the `PublishOutcome` values — the address is a new resolution axis, NOT a new outcome; keep edits to the `<target>` description.

### Test notes

No unit test for skill prose; verification is the early proof point (a live `/work` round-trip: blocked worker → escalation send → planner reply via the inbox Monitor → reconcile → resume) plus `keeper prompt render-plugin-templates` producing a clean, committed re-render. Confirm `bun run test:full` stays green (no code paths changed here beyond Task 1).

## Acceptance

- [ ] allowed-tools widened by exactly `Bash(keeper bus chat send:*)`
- [ ] Phase 2c added; both block exits (`:126`, `:169`) route through it; one escalation per block with the invocation-local guard; non-`delivered` falls back to surface-BLOCKED-and-stop; the wielder never edits code and resumes only via the existing Phase 2b machinery
- [ ] Guardrails reconciled (escalation, not retry); self-send-to-creator degrade noted
- [ ] `keeper prompt render-plugin-templates` run; rendered `work/SKILL.md` + `.managed-file-dont-edit` sidecar committed together
- [ ] `planner@<epic_id>` documented in bus SKILL.md, `cli/bus.ts` help/JSDoc, and the README bus-relay prose — forward-facing, folded into existing sentences, no implied new outcome
- [ ] `bun run test:full` green

## Done summary

## Evidence
