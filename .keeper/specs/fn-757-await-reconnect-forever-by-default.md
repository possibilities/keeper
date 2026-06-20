## Overview

`keeper await` blocks on a condition by subscribing to keeperd's UDS and
evaluating predicates client-side. Today it deliberately opts into a 30s
continuous-unpainted give-up (`AWAIT_GIVE_UP_MS` / `AWAIT_GIVE_UP_POLICY`,
fn-750.2): when keeperd stays unpainted past the deadline — including a
long-running wait whose anchor re-arms on a post-paint drop — it fires
`failed reason=unreachable` exit 1. During active keeperd development a
restart routinely exceeds 30s, so blocked awaits die mid-bounce.

The shared subscribe driver in `src/readiness-client.ts` already defaults
to reconnect-forever (the `giveUpPolicy` is opt-in; the board/TUI and the
`server-up` condition already rely on the default-off behavior). So the fix
is to stop `keeper await` opting in: reconnect-forever becomes the default
for every condition, and a new opt-in `--connect-timeout <dur>` flag
restores the bounded `reason=unreachable` path for non-interactive/CI
callers that want it. `--timeout` (condition deadline) and Monitor's own
kill timeout remain the normal bounds. Client-only — no schema/server/RPC
change.

## Quick commands

- `bun test test/await.test.ts` — the await suite (parse + behavior tests)
- `keeper await server-up` — reconnect-forever escape hatch (still works)
- `keeper await complete fn-1-foo` — now blocks through a keeperd bounce
- `keeper await complete fn-1-foo --connect-timeout 30s` — opt-in bounded
  backstop (fires `failed reason=unreachable` exit 1 if never painted)
- `bun scripts/subscribe-bounce-soak.ts` — RSS-flatness leak canary

## Acceptance

- [ ] A plain `keeper await <cond>` (no flag) reconnects forever and never
  emits `reason=unreachable`; it survives an arbitrarily long keeperd bounce
  and fires `met` once the daemon is back and the condition holds.
- [ ] `--connect-timeout <dur>` restores the bounded path: an unpainted wait
  past the window fires `failed reason=unreachable` exit 1, for both the
  never-connected and was-connected-then-lost (post-paint drop) cases.
- [ ] `--connect-timeout` combined with `server-up` is rejected at parse time
  (usage error, exit 1), mirroring the existing server-up exclusivity check.
- [ ] HELP, README await section, and the keeper:await SKILL doc are updated
  so `reason=unreachable` is documented as flag-only and the stale
  "server-up is the only give-up-exempt stream" claims are reconciled.
- [ ] `subscribe-bounce-soak.ts` shows flat RSS under a bouncing daemon (no
  socket/timer leak regression on the now-default reconnect path).

## Early proof point

Task that proves the approach: `.1` (the whole change is one task). The
keystone risk is the test rewrite: the two existing `unreachable` tests
(`test/await.test.ts:1487`, `:1522`) assume give-up-by-default and must be
rewritten to opt in via `--connect-timeout`. If they can't be made to drive
the deadline through the injected `now` clock with the flag set, the
`connectTimeoutMs` plumbing is wrong — fix the arg/policy wiring first.

## References

- fn-750.2 introduced the give-up deadline being removed here; fn-750.1
  added the `GiveUpPolicy` machinery (stays — now opt-in-only).
- Overlap: fn-756 (strip approval) may diagnostically read `cli/await.ts`
  while its task `.2` is in progress; no planned write overlap. Wired as an
  epic dep to serialize edits to `cli/await.ts`.

## Docs gaps

- **cli/await.ts HELP block**: add `--connect-timeout` to Flags; scope the
  `unreachable` Reasons entry + Exit-codes note to "flag only".
- **README.md (~956-993)**: the "bounded continuous-unpainted give-up
  (fn-750.1/.2)" sentence becomes wrong — rewrite to reconnect-forever
  default + opt-in flag; drop server-up's "(opts out of the give-up
  deadline)" parenthetical.
- **skills/await/SKILL.md**: server-up parenthetical (~77), Reasons-table
  `unreachable` row (~220), and recovery prose (~285-287, "recovery path
  when a plain `keeper await <id>` exits unreachable") must be conditioned
  on the flag — a plain await no longer exits unreachable.

## Best practices

- **Name the flag after the phase it bounds:** `--connect-timeout` is the
  curl / grpc-health-probe / clig.dev convention for "how long to spend
  reaching the server", orthogonal to `--timeout` (condition wait). [practice-scout]
- **Default reconnect-forever for long-lived observers; bounded failure is
  explicit opt-in** (cf. wait-for-it `-t 0`, kubectl). [practice-scout]
- **Don't regress the reconnect hygiene now on the default path:** keep the
  `socket.terminate()` (fn-750.3) teardown and the 250ms→5000ms backoff cap
  — reconnect-forever-by-default means more reconnects in the common case.
  Verify with the soak harness. [practice-scout]
