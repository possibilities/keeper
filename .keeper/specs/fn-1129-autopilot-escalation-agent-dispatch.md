## Overview

Autopilot's two creator-wake escalations become autonomous dispatches: a blocked task dispatches an `unblock::<task>` session, and a sticky `worktree-merge-conflict` (after the tier-1 `resolve::` resolver declines) dispatches a `deconflict::<epic>` session — fresh sonnet/high sessions booting purpose-built plan skills that load a `keeper escalation-brief` envelope (incident details, ids, creator lineage with closer-to-original-creator resolution, transcript pointers) and resolve the incident without the creator's context. The human is notified exactly once, via botctl, only when an escalation session declines or dies.

## Quick commands

- bun test test/daemon.test.ts  # sweep + once-marker semantics
- keeper escalation-brief deconflict::<epic-id> | jq .lineage  # envelope incl. closer→original-creator on a real board
- keeper dispatch unblock::<task-id>  # manual-parity smoke of the escalation launch config

## Acceptance

- [ ] A blocked task with an escalatable category yields exactly one `unblock::<task>` sonnet/high dispatch and no planner@ bus message; TOOLING_FAILURE/unparseable still suppress
- [ ] A sticky worktree-merge-conflict whose resolver reached a terminal decline/death yields exactly one `deconflict::<epic>` dispatch and no planner@ message
- [ ] An escalation session that declines or dies triggers exactly one human notification; sticky state stays operator-visible; `retry_dispatch` re-arms the whole marker chain
- [ ] `keeper escalation-brief` resolves a closer creator back to the original creator, with session ids and transcript paths for both
- [ ] The old escalation-body builders and any orphaned planner@ notify plumbing are deleted; docs, glossary, and ADR updated
- [ ] A global cap bounds concurrent escalation sessions; per-epic serialization bounds unblock fan-out

## Early proof point

Task that proves the approach: `.2` (escalation-brief). The cross-store lineage assembly is the novel data path; if keeper core cannot cleanly read the `.keeper` fields, fall back to skill-side two-call assembly (`keeper query jobs` + a plan verb) and respec task .4.

## References

- `fn-1123-worktree-lane-pre-merge-recovery` (overlap) — rewrites the autopilot-worker fan-in that mints `worktree-merge-conflict` and wires daemon escalation-gate exemptions; its specs assume the `close::<epic>` merge-escalation path stays untouched, and this epic rewires that path's consumer — sequenced behind fn-1123
- `fn-1122-suite-baseline-store` (overlap) — adds daemon.ts supervisor wiring near the restart-ledger helpers; same-file merge risk only
- Resolver machinery (the mirror pattern): `dispatchResolver` src/daemon.ts:7600, `runResolverDispatchSweep` src/daemon.ts:1575, once-marker migrations src/db.ts:5753 and src/db.ts:5896, UPSERT preserve-list src/reducer.ts:4003
- Practice grounding: CodeRabbit auto-resolve decline conditions; OWASP ASI06 context poisoning (transcripts as untrusted data); DLQ/circuit-breaker escalation patterns

## Docs gaps

- **plugins/plan/skills/plan/references/operator-orchestration.md**: prune the wake-the-creator blocked-worker procedure and its verbatim message quote — replaced by the unblock:: dispatch flow
- **CLAUDE.md** (autopilot paragraph): revise the merge-escalation sweep sentences from planner@-notify to deconflict-dispatch semantics
- **docs/plugin-composition-map.md**: add the unblock::/deconflict:: launch producers and the separate escalation preset note
- **plugins/plan/README.md**: add escalation-brief to the Command Map; keep the `keeper plan unblock` board verb distinct from the unblock skill
- **CONTEXT.md**: entries for the two new session types; boundary note on the Resolver entry

## Best practices

- **Two-tier resolve+verify:** gate commit/retry on parsed exit codes and git/keeper output, never on agent self-narration [CodeRabbit, Copilot]
- **Regenerate lockfiles:** `uv lock` / `pnpm install --lockfile-only` on lockfile conflicts, never hand-merge [multi-source]
- **Explicit decline conditions in the skill:** security-critical code, incompatible business logic, both-intents-cannot-coexist [CodeRabbit]
- **Transcripts as labeled untrusted data** with least-privilege tool frontmatter; a cheaper model means a tighter allowlist, not a looser one [OWASP ASI06]
- **Idempotency + circuit breaking on the dispatcher:** once-markers, per-epic serialization, global live-session cap [DLQ patterns]
