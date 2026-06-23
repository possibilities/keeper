## Overview

When a `planner@<epic>` Agent Bus escalation resolves to a creator session that is KNOWN but OFFLINE, two things must happen: the escalation must be DURABLE (delivered when the planner returns) and the planner must be RESUMED so it returns and acts. fn-916 shipped the role addressing + `/work` Phase 2c and left the `not_connected` seam (`src/bus-worker.ts:902-923`, comment "the seam for a future wake-on-send"). This epic fills it: durable delivery over the existing `messages` table (no schema bump), plus a `keeper bus wake` verb that resumes the creator via `claude --resume` into a NEW dedicated `agentbus` tmux session, auto-invoked by `/work` Phase 2c.

**Autoclose / window reaping is OUT OF SCOPE** — a separate, orthogonal cleanup system (owned by the `investigate-keeper-cleanup` agent) handles reaping/persist-config for the `agentbus` session. This epic only spawns into `agentbus`; it never reaps. Woken windows accumulate there until that system covers them.

## Quick commands

- `bun test test/bus-worker.test.ts test/bus-db.test.ts test/bus-cli.test.ts` — fast-tier durable-delivery cases
- `bun test test/exec-backend.test.ts test/resume-descriptor.test.ts` — fast-tier wake/argv cases
- `bun run test:full` — mandatory before landing (touches bus-worker / bus-db / exec paths)
- smoke: `printf 'esc' | keeper bus chat send "planner@<offline-epic>" -` → `queued_for_wake` (exit 0); then `keeper bus wake planner@<offline-epic>` → resumes into the `agentbus` tmux session

## Acceptance

- [ ] An offline `planner@<epic>` send persists `status:'queued_for_wake'` with `resolved_session_id` = the creator's `job_id`; a generic offline name send still stays `not_connected`
- [ ] On resubscribe, a returning session receives ONLY its own `queued_for_wake` rows (recipient-keyed, namespace-safe), each flipped to `delivered_after_wake` so a second subscribe never redelivers
- [ ] `queued_for_wake` is a publish outcome exit-0 on `keeper bus chat send`; `/work` Phase 2c treats it as yield-and-wake, not the surface-BLOCKED-and-stop fallback
- [ ] `keeper bus wake planner@<epic>` resumes the creator via `claude --resume` into the `agentbus` session, single-flighted per session (no double-spawn), skipped when the creator is already live, and cooldown-gated against thrash
- [ ] The bus worker never spawns and never posts to main (the wake is client-side in the CLI verb); no bus.db schema bump; autoclose/reaping is NOT implemented here
- [ ] `bun run test:full` green

## Early proof point

Task `.1` (durable delivery) proves the queue+replay end-to-end in fast-tier without git/daemon/tmux. If it fails, the `resolved_session_id` source or the recipient-keyed replay is wrong — fix before the wake. The riskiest unproven piece is `.2`'s end-to-end resume→redeliver→act loop (a headless `claude --resume` re-arming `keeper bus watch` and the queued message re-invoking the loop) — its acceptance must include a real integration check.

## References

- Builds on fn-916 (planner-role addressing + `/work` Phase 2c); upstream pair-transcript fix landed as fn-910.
- Design panel-judged in the originating `/hack` session; collision scan confirmed all autoclose/reaper epics (fn-640/727/741/743/771/802/810/820) DONE and the canonical reaper is fn-802 — but autoclose is deliberately deferred to the orthogonal cleanup system here.
- Best-practice grounding: TOCTOU double-spawn (CWE-367), idempotent redelivery (stable producer key), circuit-breaker/cooldown for flap, idle-exit-loop anti-pattern.

## Docs gaps

- **plugins/keeper/skills/bus/SKILL.md**: add the `keeper bus wake` verb + `queued_for_wake`/`delivered_after_wake` outcomes; qualify the "never queued to land later" line (false now for `planner@<epic>` role sends).
- **cli/bus.ts HELP**: add `wake` to usage + the two new outcomes.
- **README.md** Agent Bus relay (~:2993): durable delivery + the `agentbus` managed session (note autoclose is owned elsewhere).
- **CLAUDE.md**: the bus relay does NOT spawn (wake is client-side CLI); `agentbus` is a managed session whose reaping is the cleanup system's, not this epic's.
