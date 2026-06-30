## Overview

Give an agent near-total READ visibility over the keeper board in one
place. Extend the shared readiness snapshot with the autopilot mode /
armed-set / caps / worktree_mode it already computes but drops; add direct
JSON read commands (`keeper status`, `keeper query`) so an agent orients
without working around TUI snapshot defaults; tighten `await complete` to
fire at the done-AND-idle moment autopilot actually unblocks downstream
work; and add board-level + activity watches (`drained`, `epic-added`,
`epic-removed`, `changed`, `keeper watch`). All READ-surface expansion —
the seven-RPC write boundary is untouched.

## Quick commands

- `keeper status --json | jq .data.autopilot` — board + autopilot in one read
- `keeper query epics --json | jq '.data[].epic_id'` — one-shot collection read
- `keeper await drained` — block until the board is fully drained
- `keeper watch --json` — NDJSON tail of board deltas

## Acceptance

- [ ] `ReadinessClientSnapshot` carries autopilot `mode`, armed set, caps, and `worktree_mode`; board/dash render byte-identically (additive only).
- [ ] `keeper status --json` prints one JSON envelope (board + autopilot + counts + drained/jammed + in-flight + needs-human + `{rev, catching_up}`), exits 0 on any board state, exit 1 only on transport/usage; bounded ~10s connect deadline when the daemon is down.
- [ ] `keeper query <collection> [--filter k=v] [--json]` reads any allowlisted collection via `queryCollection`; an off-allowlist name is rejected at parse time (exit 1), never a daemon round-trip; never routes through `sendControlRpc`.
- [ ] `await complete` fires on the readiness `completed` verdict (done-AND-idle) for both task and epic; the done-but-stale-subagent behavior change is documented.
- [ ] `await drained` / `epic-added` / `epic-removed` / `changed` work as pure predicates over the snapshot, reusing the existing exit taxonomy (0/1/3/4/5) with no renumbering.
- [ ] `keeper watch --json` emits a baseline snapshot then coarse deltas, suppresses null-diffs, and never exits.
- [ ] `bun test` green; new CLI subcommands have routing tests in `test/keeper-cli.test.ts`; new predicates have pure fixture tests.

## Early proof point

Task that proves the approach: task 1 (snapshot extension). If the autopilot
fields can't be un-dropped without perturbing board/dash first-paint, the
whole orient story narrows — verify board/dash render byte-identically before
building the commands on top.

## References

- JSON-output precedent: `src/snapshot.ts` (`SNAPSHOT_SCHEMA_VERSION`, `KEEPER_META_PREFIX`); plan emitter `plugins/plan/src/format.ts` (`{success}`/`jsonDumps`).
- One-shot subscribe precedent: `keeper await server-up` (`cli/await.ts` first-paint→dispose→exit).
- Subcommand registration is a 3-touch contract in `cli/keeper.ts` (`SUBCOMMANDS` :22-47, `USAGE` :50-95, `handlers` :161-191).

## Docs gaps

- **README.md `## Example clients` (~771-1494)**: add `status`/`query`/`watch` bullets in the established shape; revise the await subsection's "seven conditions" enumeration and the `subscribeReadiness` snapshot-field prose. Owned by task 5.
- **plugins/keeper/skills/{await,autopilot,dispatch,handoff}/SKILL.md**: orient-first reshape + new condition rows + repoint off `--snapshot`. Owned by task 5.
- **CLAUDE.md**: no change — read-only expansion, the seven-RPC list stays correct.

## Best practices

- **JSON as contract:** top-level integer `schema_version`, snake_case, consistent `{schema_version, ok, error, data}` envelope; consumers ignore unknown fields; bad board state is DATA (exit 0), reserve non-zero for transport/usage.
- **NDJSON for an LLM:** coarse deltas not raw events (firehose = context-budget hazard), suppress null-diffs, idle keepalive carrying the cursor, `--filter` named-type allowlist (no free-form eval = injection surface).
- **Block-until:** level-triggered (check on entry, exit 0 if already satisfied); `drained` must distinguish jammed (sticky `dispatch_failures`) from drained before reporting.
- **One-shot read:** finite default deadline, no reconnect-loop, dispose the handle or the process never exits.
