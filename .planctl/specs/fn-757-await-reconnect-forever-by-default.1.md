## Description

**Size:** M
**Files:** cli/await.ts, test/await.test.ts, README.md, skills/await/SKILL.md

### Approach

Stop `keeper await` opting into the give-up deadline; make reconnect-forever
the default for every condition, exactly as `server-up` already behaves.
Replace the hardcoded opt-in with an opt-in `--connect-timeout <dur>` flag:

1. Remove `AWAIT_GIVE_UP_MS` and `AWAIT_GIVE_UP_POLICY` (cli/await.ts:80-92).
2. Add `"connect-timeout": { type: "string" }` to the `parseArgs` options
   (cli/await.ts:344-363); add `connectTimeoutMs: number | null` to
   `ParsedArgs` (cli/await.ts:236-245), mirroring `timeoutMs`. Parse + validate
   by cloning the `--timeout` block (cli/await.ts:492-503), reusing
   `parseDurationMs` (cli/await.ts:310-332) — do NOT write a second parser.
3. Build the give-up extras ONLY when `connectTimeoutMs` is set and `> 0`
   (mirror the `--timeout` `> 0` arming guard at cli/await.ts:1514; `0`/absent
   = no deadline = reconnect-forever). When set, construct
   `{ giveUpPolicy: { deadlineMs: connectTimeoutMs }, ...(now) }` and spread it
   at the three give-up-eligible subscribe sites (readiness/git/jobs,
   cli/await.ts:1548/1560/1572); when unset, pass neither (so `now` stays
   paired with the policy). `server-up` (cli/await.ts:1582-1591) stays exempt.
4. Reject `--connect-timeout` combined with `server-up` at parse time
   (usage error), alongside the existing server-up exclusivity check
   (cli/await.ts:482-490).
5. Leave the `onFatal` `reason=unreachable` branch (cli/await.ts:1470-1484)
   intact — it is naturally dead without the flag (the driver only fires
   `unreachable` when it has a `giveUpPolicy`). Do NOT guard the branch itself.
   The `reason=connect` fallthrough stays unconditional.
6. Update the in-CLI `HELP` constant (cli/await.ts:98-171): add a
   `--connect-timeout <dur>` Flags entry mirroring `--timeout`; scope the
   `unreachable` Reasons line + Exit-codes note to "only with
   --connect-timeout"; document the `--connect-timeout <= --timeout`,
   first-to-fire-wins relationship.
7. Reconcile the now-stale doc-comments that call server-up "the only
   give-up-exempt stream" (cli/await.ts:718-721, 1576-1581) — after this
   change every stream is exempt by default.

Do NOT touch `src/readiness-client.ts` — the `GiveUpPolicy` type
(:249-256), the give-up driver (`armGiveUp`/`disarmGiveUp`/`checkGiveUp`),
and the shared post-paint re-arm (:1262) stay; the board/TUI depend on the
default-off behavior. This change only stops await from passing a policy.

### Investigation targets

**Required** (read before coding):
- cli/await.ts:80-92 — `AWAIT_GIVE_UP_MS` / `AWAIT_GIVE_UP_POLICY` to delete
- cli/await.ts:1535-1591 — `giveUpExtras`, the three spreads, the exempt
  `server-up` subscribe (the symmetry target)
- cli/await.ts:1470-1484 — `onFatal` unreachable vs connect branches
- cli/await.ts:236-245, 344-363, 492-521 — `ParsedArgs`, parseArgs options,
  the `--timeout` parse-and-validate block to clone
- cli/await.ts:310-332 — `parseDurationMs` (reuse)
- cli/await.ts:482-490 — existing server-up exclusivity check (extend)
- cli/await.ts:98-171 — `HELP` constant
- test/await.test.ts:389-421 — `singleArgs` / `argsFor` builders (add the
  `connectTimeoutMs` field to BOTH default objects)
- test/await.test.ts:1487-1548 — the two `unreachable` tests to rewrite
- test/await.test.ts:488-523 — parse-test pattern for new flags

**Optional** (reference as needed):
- src/readiness-client.ts:249-256 — `GiveUpPolicy` shape (do not edit)
- src/readiness-client.ts:243-244, 1423-1425 — "absent policy =
  reconnect-forever" documentation
- README.md:956-993 — await architecture bullet to rewrite
- skills/await/SKILL.md:77, 220, 285-287 — server-up parenthetical,
  Reasons row, recovery prose
- scripts/subscribe-bounce-soak.ts — the RSS leak canary

### Risks

- **Test coupling to give-up-by-default.** The two `unreachable` tests
  drive the deadline via the injected `now` clock assuming an always-on
  policy; they must now set `--connect-timeout` (non-null `connectTimeoutMs`)
  or they stop tripping `unreachable`. If `now` was only ever forwarded
  inside `giveUpExtras`, confirm no non-give-up test strands a `now`
  injection when the flag is unset.
- **Agent-facing behavior change.** Monitor-wired awaits (per the SKILL)
  previously surfaced `unreachable` at 30s; they now block through bounces
  until `met` or Monitor's kill timeout. The SKILL recovery prose must be
  updated so agents don't wait for a terminal that no longer comes.
- **Reconnect hygiene on the default path.** More reconnects in the common
  case — the `socket.terminate()` fix and backoff cap are now load-bearing
  by default. Regression = the ~2GB native-socket leak.

### Test notes

- Add parse tests: `--connect-timeout 30s` → `connectTimeoutMs === 30_000`;
  invalid duration → usage error (exit 1) mirroring `--timeout`;
  `--connect-timeout` + `server-up` → parse-time usage error.
- Rewrite test/await.test.ts:1487 and :1522 to opt in via
  `--connect-timeout` and assert the same `reason=unreachable` outcomes.
- Add a NEW default-path test: with no flag, a `closeFromServer()` bounce
  past the old 30s window emits NO terminal (reconnect-forever), then a
  re-paint that satisfies the condition fires `met`.
- Run `bun scripts/subscribe-bounce-soak.ts` and confirm flat RSS.

## Acceptance

- [ ] `AWAIT_GIVE_UP_MS` / `AWAIT_GIVE_UP_POLICY` removed; no subscribe site
  passes a `giveUpPolicy` unless `--connect-timeout` is set.
- [ ] `--connect-timeout <dur>` parses via `parseDurationMs`, populates
  `ParsedArgs.connectTimeoutMs`, and arms the bounded path only when `> 0`.
- [ ] Plain await (no flag) reconnects forever — new test proves a bounce
  past 30s yields no terminal, then `met` after re-paint.
- [ ] `--connect-timeout` opt-in reproduces `reason=unreachable` exit 1 for
  never-connected AND post-paint-drop; rewritten tests pass.
- [ ] `--connect-timeout` + `server-up` rejected at parse time (exit 1).
- [ ] `now` stays paired with the policy (forwarded only when the flag is set).
- [ ] HELP, README await section, and SKILL.md updated; stale "only
  give-up-exempt stream" doc-comments reconciled.
- [ ] `src/readiness-client.ts` unchanged.
- [ ] `bun test test/await.test.ts` green; `subscribe-bounce-soak.ts` flat RSS.

## Done summary
Made keeper await reconnect-forever the default for every condition; removed AWAIT_GIVE_UP_MS/POLICY and added opt-in --connect-timeout <dur> (reuses parseDurationMs) to re-arm the bounded reason=unreachable path, with now paired to the policy and server-up rejected at parse time. Rewrote the two unreachable tests to opt in, added never-connected/post-paint-drop/default-path tests (79 pass), and reconciled HELP/README/SKILL docs. Soak flat RSS at 4000 cycles.
## Evidence
