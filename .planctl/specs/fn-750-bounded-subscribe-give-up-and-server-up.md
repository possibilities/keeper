## Overview

A runaway `keeper await` spun ~4h and leaked ~2GB because the shared
subscribe client (`subscribeMulti`) reconnects forever with no give-up, and
keeperd had bounced under it. This epic gives the shared client a per-caller
bounded give-up (exit cleanly instead of spinning), wires `keeper await` to
exit `reason=unreachable` with retry advice, and adds a `keeper await
server-up` condition that blocks through a daemon bounce so a watching agent
can re-arm. The server (event log, schema, RPC, folds) is unchanged — this
is purely client/CLI. Give-up bounds BOTH the never-connected and the
was-connected-then-lost cases (decided: full hang-forever kill), with
`server-up` as the escape hatch for a legitimately slow cold boot.

## Quick commands

- `bun test test/readiness-client.test.ts` — give-up unit coverage
- `bun test test/await.test.ts test/await-conditions.test.ts` — await wiring + server-up
- demo: stop keeperd, then `keeper await complete fn-999-nope` → exits `failed reason=unreachable` within ~the deadline (no hang)
- demo: `keeper await server-up` while keeperd is down → blocks, fires `met` on first snapshot when it returns

## Acceptance

- [ ] `subscribeMulti` supports an opt-in bounded give-up; default (board/TUI) stays reconnect-forever, zero-touch
- [ ] give-up bounds BOTH never-connected and was-connected-then-lost (continuously-unpainted >= deadline → onFatal code=unreachable)
- [ ] give-up anchor keyed off FIRST PAINT (not socket-open), so a half-up daemon still gives up
- [ ] `keeper await` opts in; emits `failed reason=unreachable ... advice=...` exit 1, distinct from connect/not-found/deleted/stuck
- [ ] `keeper await server-up` is a nullary, reconnect-forever condition that fires `met` on first snapshot; ANDing it is a parse-time usage error
- [ ] HELP text, README, SKILL.md, and readiness-client module JSDoc updated and in sync
- [ ] no schema/fold/RPC change (client-only)

## Early proof point

Task that proves the approach: `.1` (give-up in the client core with the
injectable-clock test). If it fails — the fake-timer harness can't drive a
wall-clock deadline — fall back to driving the deadline off the accumulated
`retry_in_ms` backoff sum instead of an injected clock.

## References

- Root cause: `src/readiness-client.ts:1063` `connectWithRetry` (uncapped loop), `:1002` attempt-reset-on-open, `:207` `FatalError`, `cli/await.ts:1329` onFatal→`reason=connect`.
- Potential test-helper overlap with **fn-747** / **fn-749** on `test/helpers/in-process-daemon.ts` — deliberately NOT hard-wired as a dep: our tests use the mock-connect + setTimeout-fast-forward harness (`test/readiness-client.test.ts`) and the await `makeHarness`, not the in-process daemon; the fn-747.2 seam it would depend on is already done. Coordinate only if implementation ends up touching that helper.
- Separate follow-up, explicitly OUT of scope here: the ~2GB memory leak in the reconnect/snapshot path. Give-up bounds each await's lifetime/blast radius; the leak itself warrants its own task.

## Docs gaps

- **cli/await.ts HELP** — add `server-up` to Conditions, add `reason=unreachable` + `advice=` to the reason vocabulary, update the unknown-condition error string and the exit-code line.
- **skills/await/SKILL.md** — Conditions table + Reasons/exit-code table (a `reason=unreachable` row distinct from `reason=connect`, with "daemon down >deadline → wait with server-up, then re-arm" guidance), trigger words for "wait until keeper is up", note `server-up` has no planctl pre-check.
- **README.md** — exit-code inline (~938), condition enumeration (~571), readiness-client module description (~580).
- **src/readiness-client.ts JSDoc** (lines 6/67) — replace "reconnects forever" with the per-caller give-up bullet.

## Best practices

- **Wall-clock disconnect deadline, not attempt-count:** `attempt` resets on open, so it can't bound a flapping connection; a continuous-unpainted deadline is flap-resistant. [AWS Builders Library; cenkalti/backoff]
- **Reset the clock on first-paint, not socket-connect:** a daemon accepts UDS connections before migrate/boot-drain finishes; readiness = first real response. [Kubernetes readiness probes]
- **server-up disposes immediately on first snapshot:** one-shot, no lingering poll/reconnect timer. [Node timer-leak guidance]
