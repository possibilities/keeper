## Overview

A runaway `keeper await` spun ~4h and leaked ~2GB because the shared
subscribe client (`subscribeMulti`) reconnects forever with no give-up, and
keeperd had bounced under it. This epic has three pillars: (1) a per-caller
bounded give-up so a client exits cleanly instead of spinning; (2) `keeper
await` wired to exit `reason=unreachable` with retry advice, plus a `keeper
await server-up` condition that blocks through a daemon bounce so a watching
agent can re-arm; (3) the actual fix for the ~2GB memory leak in the
reconnect/snapshot path. Pillar 3 is load-bearing, NOT a follow-up: the
board TUI deliberately opts OUT of give-up (reconnect-forever), so the leak
is unbounded for the one client meant to run forever — give-up alone does
not cover it. The server (event log, schema, RPC, folds) is unchanged —
purely client/CLI. Give-up bounds BOTH the never-connected and the
was-connected-then-lost cases (decided: full hang-forever kill), with
`server-up` as the escape hatch for a legitimately slow cold boot.

## Quick commands

- `bun test test/readiness-client.test.ts` — give-up + leak unit coverage
- `bun test test/await.test.ts test/await-conditions.test.ts` — await wiring + server-up
- the bounce-soak harness (task `.3`) → flat RSS across N daemon bounces
- demo: stop keeperd, then `keeper await complete fn-999-nope` → exits `failed reason=unreachable` within ~the deadline (no hang)
- demo: `keeper await server-up` while keeperd is down → blocks, fires `met` on first snapshot when it returns

## Acceptance

- [ ] `subscribeMulti` supports an opt-in bounded give-up; default (board/TUI) stays reconnect-forever, zero-touch
- [ ] give-up bounds BOTH never-connected and was-connected-then-lost (continuously-unpainted >= deadline → onFatal code=unreachable)
- [ ] give-up anchor keyed off FIRST PAINT (not socket-open), so a half-up daemon still gives up
- [ ] `keeper await` opts in; emits `failed reason=unreachable ... advice=...` exit 1, distinct from connect/not-found/deleted/stuck
- [ ] `keeper await server-up` is a nullary, reconnect-forever condition that fires `met` on first snapshot; ANDing it is a parse-time usage error
- [ ] the ~2GB reconnect/snapshot leak is reproduced, root-caused, and fixed — a bounce-soak harness shows FLAT RSS across N bounces (the board-TUI/reconnect-forever client no longer grows)
- [ ] HELP text, README, SKILL.md, and readiness-client module JSDoc updated and in sync
- [ ] no schema/fold/RPC change (client-only)

## Early proof point

Task that proves the approach: `.1` (give-up in the client core with the
injectable-clock test). If it fails — the fake-timer harness can't drive a
wall-clock deadline — fall back to driving the deadline off the accumulated
`retry_in_ms` backoff sum instead of an injected clock.

## References

- Root cause: `src/readiness-client.ts:1063` `connectWithRetry` (uncapped loop), `:1002` attempt-reset-on-open, `:207` `FatalError`, `cli/await.ts:1329` onFatal→`reason=connect`.
- Potential test-helper overlap with **fn-747** / **fn-749** on `test/helpers/in-process-daemon.ts`, and a possible `scripts/` soak-harness overlap with **fn-747**'s slow-tier soak work — deliberately NOT hard-wired as deps: the give-up/server-up tests use the mock-connect + setTimeout-fast-forward harness (`test/readiness-client.test.ts`) and the await `makeHarness`, not the in-process daemon; the fn-747.2 seam is already done. Coordinate only if implementation touches those helpers.
- Leak status: the ~2GB reconnect/snapshot leak is now IN SCOPE as task `.3` (was wrongly framed as an out-of-scope follow-up). Static analysis this session ruled out in-process re-fold (TUI-only refold poller), reconnect-chain accumulation, per-collection map growth, and await-runner retention; lead remaining suspect is undestroyed sockets on teardown (`teardownConnection` nulls `currentSock` at `:980` but never `sock.destroy()`s it). Needs runtime repro to confirm.

## Docs gaps

- **cli/await.ts HELP** — add `server-up` to Conditions, add `reason=unreachable` + `advice=` to the reason vocabulary, update the unknown-condition error string and the exit-code line.
- **skills/await/SKILL.md** — Conditions table + Reasons/exit-code table (a `reason=unreachable` row distinct from `reason=connect`, with "daemon down >deadline → wait with server-up, then re-arm" guidance), trigger words for "wait until keeper is up", note `server-up` has no planctl pre-check.
- **README.md** — exit-code inline (~938), condition enumeration (~571), readiness-client module description (~580).
- **src/readiness-client.ts JSDoc** (lines 6/67) — replace "reconnects forever" with the per-caller give-up bullet.

## Best practices

- **Wall-clock disconnect deadline, not attempt-count:** `attempt` resets on open, so it can't bound a flapping connection; a continuous-unpainted deadline is flap-resistant. [AWS Builders Library; cenkalti/backoff]
- **Reset the clock on first-paint, not socket-connect:** a daemon accepts UDS connections before migrate/boot-drain finishes; readiness = first real response. [Kubernetes readiness probes]
- **server-up disposes immediately on first snapshot; destroy sockets on teardown:** one-shot, no lingering poll/reconnect timer, and no undestroyed-socket/native-buffer accumulation across reconnects. [Node timer-leak + long-running-service guidance]
