## Description

**Size:** M
**Files:** babysitters/performance/watch.ts, babysitters/performance/watchdog.ts (delete), babysitters/lib/, test/keeper-watch.test.ts, test/keeper-watchdog.test.ts (delete), test/babysitter-build.test.ts

### Approach

Rewrite `tick()` to the page-free flow: scan → held-gate → cold-start silent
baseline → select genuinely-new findings → WRITE FOLLOWUPS IN-PROCESS → fold
seen-state → writeHeartbeat. Remove `spawnAgentLive`, `SpawnAgentFn`,
`SpawnResult`, the ack-file protocol, the frozen `findings.<uid>.json`
handoff, and the dead constants (`AGENT_TIMEOUT_MS`, `PLAIN_CLAUDE_PATH`,
`BABYSITTERS_PLUGIN_DIR`, `REPO_ROOT`, `COOLDOWN_SECS`, `MAX_SPAWN_RETRIES`,
`TRIAGE_AGENT`). Grep for stragglers with `grep -a` (watch.ts reads as
binary to grep — emoji chars).

Followup writing: extract the writer fn-791 task 1 builds in
`babysitters/helptailing/watch.ts` into a shared dep-free
`babysitters/lib/followups.ts` (or consume it there directly if fn-791
already placed it in lib) and call it from this tick. The format is the
contract from `babysitters/agents/performance.md:203-338`: filename
`<slug>-<unix-ts>-<sha1_8(key)>.md`, YAML frontmatter
(key/fingerprint/category/severity — canonical), injection-safe fenced
`## Evidence` echoing untrusted DB strings, `latest.md` via tmp+rename.
Add `first_seen_at`/`last_seen_at` to frontmatter (schema-additive) from the
SeenEntry. Writes are BEST-EFFORT: a failed write logs, skips committing
that fingerprint to seen-state (so it retries next tick), and the tick still
exits 0 — never throw, never wedge. mkdir -p the followups dir per write
pass, degrade like writeHeartbeat on failure.

Write predicate: the existing genuinely-new selection (seen-state diff)
gates writes; the held-tick / delta confirmation gates SURVIVE (they encode
signal confirmation, not page rate). `selectToNotify` simplifies to a
select-to-write without cooldown/retry-cap branches; `foldSeenState`
commits "written" instead of delivered/spawnFailed. Drop
`notification_count`/`last_notified_at`/`spawn_failures` from `SeenEntry`
and bump `SEEN_STATE_VERSION` — the one-time silent re-baseline on the
production host is an accepted cost (persistent findings re-fire next tick;
previously-paged findings already have followups).

Watchdog retirement, same commit: delete
`babysitters/performance/watchdog.ts` and `test/keeper-watchdog.test.ts`,
drop the watchdog entry from `SITTER_ENTRYPOINTS` and update the watch.ts
public-surface pin in `test/babysitter-build.test.ts` (spawn exports gone).
`writeHeartbeat` STAYS — `/babysit-triage` reads staleness as the liveness
signal. Plist/README cleanup belongs to task 2; this task is code + tests.

### Investigation targets

**Required** (read before coding):
- babysitters/performance/watch.ts:2402-2565 — tick() being rewritten
- babysitters/performance/watch.ts:2186-2261 — selectToNotify/foldSeenState being simplified
- babysitters/performance/watch.ts:1936-2071 — SeenEntry shape, SEEN_STATE_VERSION, loadSeenState empty-on-mismatch
- babysitters/performance/watch.ts:2099-2160 — held-gate/delta gates that SURVIVE
- babysitters/agents/performance.md:203-338 — the followup format being ported (preserve the injection contract EXACTLY)
- .planctl/specs/fn-791-build-helptailing-babysitter-producer.1.md — the writer being shared; align module placement with whatever fn-791.1 landed
- test/keeper-watch.test.ts:2035-2300 — the spawn/cooldown tests being rewritten to write-path tests
- test/babysitter-build.test.ts:44-69 — SITTER_ENTRYPOINTS + public-surface pin
- babysitters/lib/state.ts:14 — babysitterStateDir; never re-derive paths

### Risks

- The injection-safety contract (fenced Evidence, sanitized filenames, no
  interpolation of event data into paths) regressing in the TS port — a
  regression writes executable-looking prompts from untrusted DB strings.
  Port test cases for hostile keys/titles.
- fn-791.1 may land its writer in-scanner rather than in lib; the fallback
  is a performance-local writer with the identical format (epic Early proof
  point) — do not block on a refactor of helptailing.

### Test notes

Rewrite describe("tick")/describe("selectToNotify")/describe("foldSeenState")
around the write path: genuinely-new finding writes exactly one followup;
unchanged finding on the next tick writes nothing; failed write retries next
tick and exits 0; re-fire after TTL writes a new file; hostile evidence
strings stay fenced; latest.md is tmp+renamed. freshDbFile()/quietDeps
patterns as in keeper-watch.test.ts:137-186. `bun run test:full` mandatory.

## Acceptance

- [ ] `grep -a -n 'botctl\|spawnAgent\|notifyctl\|ack' babysitters/performance/watch.ts` shows no live call sites; watchdog.ts and its test deleted
- [ ] Followups written in-process via the shared lib writer, byte-compatible with the three-shape key extraction in FINDINGS-LEDGER.md, frontmatter gains first_seen_at/last_seen_at
- [ ] Held/delta gates and seen-state dedup intact (tests pin: one followup per genuinely-new finding, none for persisting unchanged findings)
- [ ] SEEN_STATE_VERSION bumped; SeenEntry page-history fields gone
- [ ] Best-effort writes: failure path exits 0 and retries next tick (test pinned)
- [ ] babysitter-build.test.ts updated (entrypoints + surface pin); fast tier and `bun run test:full` green

## Done summary

## Evidence
