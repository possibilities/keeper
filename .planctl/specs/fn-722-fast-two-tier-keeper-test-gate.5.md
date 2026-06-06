## Description

**Size:** S
**Files:** test/events-writer.test.ts

### Approach

The file already imports the writer's exported functions (line ~39) AND spawns the real hook via a generated launcher at 5 sites. Convert assertion-only tests that don't need process isolation to in-process calls of the exported deriver/writer functions (routed through the shared sandbox-env helper from task 2 so they never read default env). KEEP a real `Bun.spawn` set for the load-bearing contract tests: exit-0 (a non-zero exit fail-closes the human's session), dead-letter file write, and column-narrowing via `PRAGMA table_info` (fn-669). Build an explicit keep-as-spawn list before converting — converting an exit-code or process-isolation test to in-proc silently deletes that coverage.

### Investigation targets

**Required** (read before coding):
- test/events-writer.test.ts:39 (writer fn imports), :77/:138/:330/:1262/:1446 (spawn sites), :111 (sandboxedBaseEnv), :1239 (fireViaLauncherWithEnv), :1432 (dead-letter override)
- CLAUDE.md "The hook must always exit 0" + column-narrowed INSERT (fn-669) — defines which tests MUST stay real subprocess

### Risks

- **Silent coverage loss:** the exit-0 / dead-letter / column-narrow tests validate process-level behavior; converting them to in-proc tests nothing. Enumerate the keep-as-spawn set first.

### Test notes

`bun test test/events-writer.test.ts` green (target ~2.8s down); confirm the kept real-spawn tests still exercise exit code, dead-letter NDJSON write, and column-narrow path.

## Acceptance

- [ ] Assertion-only tests converted to in-process calls via the shared sandbox-env helper
- [ ] exit-0 / dead-letter / column-narrow tests remain real `Bun.spawn` subprocess tests
- [ ] File passes; spawn-count reduction and wall-time recorded

## Done summary

## Evidence
