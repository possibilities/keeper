## Description

**Size:** S
**Files:** cli/commit-work.ts, test/commit-work.test.ts

### Approach

In `cli/commit-work.ts`, the null-session guard (~lines 348-356) currently
calls `fail({ success: false, error: "no session id available — ..." })`.
Replace ONLY the `fail(...)` payload with the structured `error`/`hint`
shape the `file_list_too_large` envelope already uses
(`cli/commit-work.ts:365-375`):

```js
fail({
  success: false,
  error: "no_session_id",
  hint:
    "commit-work attributes files by Claude Code session id, which isn't " +
    "set here. Commit with git directly instead: stage ONLY the files you " +
    "changed, by explicit path (git add <path> … — never -A or .), then " +
    "git commit and git push.",
});
```

Keep it flowing through `fail()` → `printCompact` → `process.exit(1)`
(unchanged; the call site is above the lock window so the exit is safe). Do
NOT mention `--session-id` in the hint. Echo the canonical "drop to git,
stage by explicit path" wording from `plugins/plan/agents/worker-high.md`.
Leave `resolveSessionId` (`src/commit-work/session-id.ts`) and the `HELP`
text untouched — only the hint is constrained to avoid `--session-id`; HELP
legitimately still documents the flag.

Then update the test block `describe("commit-work: session id", ...)` at
`test/commit-work.test.ts:159-170`: change the `error` assertion from
`toContain("no session id available")` to
`expect(parsed.error).toBe("no_session_id")`, and add
`expect(parsed.hint).toContain("git")`. Keep the existing `code === 1`,
`success === false`, and compact-single-line assertions.

### Investigation targets

**Required** (read before coding):
- cli/commit-work.ts:348-356 — the null-session `fail(...)` site to change
- cli/commit-work.ts:365-375 — the `file_list_too_large` envelope; mirror its `error`/`hint` shape and imperative hint voice
- test/commit-work.test.ts:159-170 — the no-session-id test block to update

**Optional** (reference as needed):
- src/commit-work/session-id.ts:25-35 — `resolveSessionId` order (no change; explains when null happens)
- plugins/plan/agents/worker-high.md:147 — canonical git-direct fallback wording to echo

## Acceptance

- [ ] `keeper commit-work --preview-files` with no resolvable session id returns a compact `{success:false, error:"no_session_id", hint:"..."}` and exits 1
- [ ] the `hint` tells the agent to commit with git directly, staging only changed files by explicit path (never `-A`/`.`), and does NOT mention `--session-id`
- [ ] `test/commit-work.test.ts` asserts `error === "no_session_id"` and a git-mentioning `hint`; the old `"no session id available"` assertion is gone
- [ ] `bun run test:full` passes (slow-tier file; fast `bun test` skips it)

## Done summary
Reshaped commit-work null-session guard into a structured error: no_session_id envelope with a git-direct hint; updated test to assert the new error/hint shape.
## Evidence
