## Overview

Add role-based addressing to the keeper Agent Bus so a sender can address `planner@<epic_id>` and the bus resolves it — server-side, in the pure `resolveTarget` — to the epic's creator session, with no need to know that session's name. On top of it, give the `/plan:work` orchestrator a "Phase 2c — escalate to planner once, then fall back" step: when its worker is semantically BLOCKED, the wielder sends a framed "help me unblock and complete" request to `planner@<epic_id>`, yields, and on the planner's authoritative bus reply resumes its worker (the planner either does the unblock work and commits, or directs a resume). The wielder never edits code. When no planner is reachable, it degrades to today's surface-BLOCKED-and-stop.

This is the interactive-mode payoff (the planner is a live sibling session of the same human). The autopilot-headless wake/resume-the-offline-planner case is a deliberate FOLLOW-UP epic, not in scope here.

## Quick commands

- `bun test test/bus-identity.test.ts` — fast-tier resolver cases (planner hit / offline / no-creator / malformed / multi-creator)
- `bun run test:full` — mandatory before landing (touches bus-worker + db read paths)
- `keeper prompt render-plugin-templates` — re-render `/work` SKILL.md from the template (Task 2)
- smoke: `printf 'test' | keeper bus chat send "planner@<some-open-epic-id>" -` — observe `delivered` / `not_connected` / `unknown_target`

## Acceptance

- [ ] `planner@<epic_id>` resolves to the epic's creator session(s) and delivers when one is live
- [ ] An epic with multiple creator edges resolves via `collapseByLive` (clean-pick when one is connected; `ambiguous_target` when several are)
- [ ] Unresolvable (no creator / unknown epic / malformed `job_links`) → `unknown_target`; resolved-but-offline → `not_connected` — reusing the existing `PublishOutcome` vocabulary, NO new result code, NO bus.db schema change
- [ ] `roleJobIds` never throws on malformed/empty `job_links`
- [ ] `/work` escalates to `planner@<epic_id>` exactly once per block, resumes its worker per the planner's reply via the existing Phase 2b machinery, and never edits code; on any non-`delivered` send it falls back to surface-BLOCKED-and-stop
- [ ] `planner@<epic>` is documented in the bus skill, the `keeper bus` help text, and the README bus-relay prose; the `/work` SKILL.md is re-rendered and committed with its `.managed-file-dont-edit` sidecar

## Early proof point

Task `.1` (resolver + fast-tier tests) proves the addressing end-to-end without git or a daemon. If it fails, the address grammar or the `epics.job_links` read is wrong — fix before the skill work. Task `.2`'s own crux is the wait-for-reply mechanic: verify a `/work` session re-invokes on an inbound bus reply (the armed `keeper bus watch` Monitor) before trusting Phase 2c.

## References

- Design panel-judged in the originating `/hack` session; handoff for the upstream pair-transcript fix landed as `fn-910`.
- Bus collaboration model + authority contract: `plugins/keeper/skills/bus/SKILL.md` (send-blindly, authoritative inbound directives, `LEAD:`/`HANDOFF:` hand-off vocab, loop-stop reflex, never run `keeper bus watch`).
- Creator-edge derivation (confirms multi-creator, cross-session edges never suppressed): `src/plan-classifier.ts:296-360`.
- FOLLOW-UP (separate epic, out of scope): empower `planner@<epic>` to resume/wake the planner when it is offline (autopilot-headless durable delivery).
