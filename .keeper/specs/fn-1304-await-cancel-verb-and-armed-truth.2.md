## Description

**Size:** S
**Files:** cli/await.ts, cli/descriptor.ts, src/server-worker.ts, src/await-worker.ts, src/rpc-handlers.ts, test/await.test.ts, test/rpc-handlers.test.ts, test/await-worker.test.ts, plugins/keeper/skills/await/SKILL.md

### Approach

Surface and fence the existing cancel op (ADR 0072). FIRST verify the await worker's fire path is fenced on the row being durably `waiting` within the transaction that records the fire — add the fence if absent; cancel is advisory without it. Then: main's bridge pre-checks a cancel before appending — the caller's resolved session must equal the row's recorded arming session (`target_session`), or the request carries the explicit `--force` operator override stamped into the event payload as the acting identity; mismatch, absent row, and already-terminal row all return one uniform not-cancellable refusal; re-cancel of a cancelled row is a no-op success. The fold stays owner-blind (status CAS unchanged) — enforcement is producer-side only, so historical tokenless cancel events replay identically. Add the `cancel` subcommand to the await CLI + descriptor (summary-match test tracks it), and update the await skill doc's durable section and consolidated armed-line description.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves.*

**Required** (read before coding):
- src/await-worker.ts — the claim/fire path; the durable `waiting` fence within the fire's emitting transaction is this task's precondition
- src/reducer.ts:7234-7242 — the existing cancel fold (status CAS; stays unchanged)
- src/server-worker.ts:1664-1668 — the requestAwait bridge where the producer-side owner pre-check lives (main may read the DB; RPC handlers may not)
- src/rpc-handlers.ts:837-928 — the cancel branch's key allowlist to widen for the override marker; stray-key rejection tests track it
- cli/await.ts:3191-3217 — the durable send path stamping target_session (the arming identity the fence compares against)
- cli/descriptor.ts:888-959 — the await command entry gaining its first subcommand

**Optional:**
- test/rpc-handlers.test.ts:970, 1009 — existing cancel-variant tests to extend for fencing
- src/reducer.ts:4186-4340 — the fence idiom ("omitted or malformed grants no authority") the producer check mirrors

### Risks

- The producer pre-check must read committed projection state; a racy snapshot could authorize against a stale owner.
- The uniform-refusal rule (foreign, absent, terminal → same code and message) is easy to erode with helpful error detail; keep it uniform.

### Test notes

Deterministic seams only. Cover: same-session cancel succeeds; foreign session denied uniformly with absent and terminal ids; --force override succeeds and stamps the acting identity in the payload; cancel-then-fire and fire-then-cancel orderings each converge (no follow-up after cancel folds first; idempotent no-op after fire folds first); re-cancel no-op success; malformed payload folds safely.

## Acceptance

- [ ] `keeper await cancel` from the arming session retires a waiting row; the follow-up never fires, including against a concurrent claim
- [ ] A different session's cancel, an absent id, and a terminal id all produce one uniform not-cancellable refusal; `--force` overrides with the acting identity recorded
- [ ] The fire path is fenced on durable waiting state in its emitting transaction, proven by an ordering test in both directions
- [ ] The fold and RPC surface list are unchanged; historical cancel events replay identically
- [ ] The await skill doc documents the cancel verb and the consolidated armed-line semantics

## Done summary

## Evidence
